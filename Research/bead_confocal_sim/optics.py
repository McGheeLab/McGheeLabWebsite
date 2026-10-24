"""Image formation for a fluorescent SPHERICAL SHELL (PE on the surface of an 8 um bead) on a
point-scanning confocal (Nikon AX-R), single focal plane, pinhole-set optical section.

Model
    * Shell of radius R, surface density sigma(s) [PE / um^2], discretised on a Fibonacci lattice.
    * 3-D effective confocal PSF  h(rho, z) = I_ill(rho, z) * D_ph(rho, z)
        I_ill : Gaussian excitation beam, waist w0 = 0.433 lam_ex/NA (lateral FWHM 0.51 lam/NA),
                Rayleigh range z_R = pi w0^2 n_s / lam_ex (n_s = 1.33, the sample), so a defocused
                molecule is excited more weakly AND over a wider lateral range (the cone).
        D_ph  : fraction of the molecule's defocused emission spot (Gaussian, sigma_det(z)) that passes a
                pinhole of radius a = AU * 1.22 lam_em / NA / 2 projected to the sample -> a Marcum-Q /
                non-central chi-square integral.  Large pinhole: flat-topped in z (geometric section);
                small pinhole: diffraction-limited section and a loss of in-focus signal.
      h is normalised so that a molecule at the focus of an infinitely open pinhole gives 1.
    * Pixel value (beam at r_pq) = k_em * eta * tau * sum_i sigma_i dA_i h(|s_i - r_pq|_xy, z_i - z_focus)
      with k_em the emission rate of ONE PE at the focus (saturable), eta the detection efficiency,
      tau the dwell time.  Point scanning SAMPLES the blurred object at the pixel centres (plus a
      one-pixel smear along the fast axis); it does not integrate over the pixel area.
    * Detector: photoelectrons ~ Poisson, PMT multiplication with excess-noise factor F, DN = offset +
      gain * electrons + read noise, clipped at the ADC ceiling.
    * Bleaching: a full raster delivers the same fluence P*tau/dx^2 to EVERY plane, so the per-frame
      dose per PE is uniform over the shell: sigma <- sigma * exp(-phi_b * photons_absorbed_per_frame).
"""
import numpy as np
from dataclasses import dataclass
from scipy import ndimage
from scipy.stats import ncx2
from scipy.fft import rfft2, irfft2, next_fast_len

H_PLANCK = 6.62607015e-34
C_LIGHT = 2.99792458e8
N_AVO = 6.02214076e23
N_SAMPLE = 1.33


@dataclass
class Objective:
    name: str
    M: float
    NA: float
    n_imm: float = 1.0          # dry objectives

    def collection_fraction(self, n_sample=N_SAMPLE):
        s = min(self.NA / n_sample, 1.0)
        return 0.5 * (1.0 - np.sqrt(1.0 - s ** 2))


OBJ = {
    '10x': Objective('Plan Apo lambda 10x/0.45', 10, 0.45),
    '20x': Objective('Plan Apo lambda 20x/0.75', 20, 0.75),
    '20xD': Objective('Plan Apo lambda D 20x/0.80', 20, 0.80),
}


@dataclass
class Fluorophore:
    name: str = 'R-PE'
    eps_M_cm: float = 1.96e6      # M^-1 cm^-1 near the 565 nm peak
    QY: float = 0.82
    tau_fl_s: float = 2.5e-9
    phi_bleach: float = 1.1e-5     # R-PE photodestruction quantum yield (White & Stryer 1987); 6.5e-6 with n-propyl gallate
    lam_em_um: float = 0.578

    @property
    def sigma_abs_cm2(self):
        return 3.82e-21 * self.eps_M_cm   # ln(10)*1000/N_A

    @property
    def sigma_abs_m2(self):
        return self.sigma_abs_cm2 * 1e-4


PE = Fluorophore()


def airy_unit_um(obj, lam_em=0.578):
    """Airy disc diameter at the sample (um); the AX pinhole is specified in these units."""
    return 1.22 * lam_em / obj.NA


def psf_fwhm_zeiss(obj, pinhole_AU, lam_ex=0.561, lam_em=0.578):
    """Textbook (Zeiss/Pawley) FWHM estimates, for comparison with the explicit model below.
    PH >= 1 AU: FWHM_z = sqrt((0.88 lam_em/(n - sqrt(n^2-NA^2)))^2 + (sqrt2 n PH/NA)^2), FWHM_xy = 0.51 lam_em/NA
    PH -> 0  : FWHM_z = 0.64 lam_bar/(n - sqrt(n^2-NA^2)),  FWHM_xy = 0.37 lam_bar/NA   (n = immersion index)."""
    n, NA = obj.n_imm, obj.NA
    lam_bar = np.sqrt(2) * lam_ex * lam_em / np.sqrt(lam_ex ** 2 + lam_em ** 2)
    PH = pinhole_AU * airy_unit_um(obj, lam_em)
    denom = n - np.sqrt(n ** 2 - NA ** 2)
    if pinhole_AU <= 0.25:
        return 0.37 * lam_bar / NA, 0.64 * lam_bar / denom, PH
    return 0.51 * lam_em / NA, np.sqrt((0.88 * lam_em / denom) ** 2 + (np.sqrt(2) * n * PH / NA) ** 2), PH


class ConfocalPSF:
    """Tabulated h(rho, z) for one objective / pinhole / wavelength set."""
    _cache = {}

    def __new__(cls, obj, pinhole_AU, lam_ex=0.561, lam_em=0.578, n_s=N_SAMPLE):
        key = (obj.name, float(pinhole_AU), lam_ex, lam_em, n_s)
        if key in cls._cache:
            return cls._cache[key]
        self = super().__new__(cls)
        cls._cache[key] = self
        NA = obj.NA
        self.obj, self.AU, self.lam_ex, self.lam_em = obj, pinhole_AU, lam_ex, lam_em
        self.w0 = 0.433 * lam_ex / NA
        self.zR = np.pi * self.w0 ** 2 * n_s / lam_ex
        self.s_em = 0.51 * lam_em / NA / 2.3548
        self.zR_em = np.pi * (2 * self.s_em) ** 2 * n_s / lam_em
        self.a = pinhole_AU * airy_unit_um(obj, lam_em) / 2
        # table
        self.zmax = 14.0
        self.dz = 0.05
        self.zg = np.arange(0, self.zmax + self.dz / 2, self.dz)
        wmax = self.w(self.zmax)
        self.rmax = min(2.5 * wmax, self.a + 3.5 * self.s_det(self.zmax)) + 0.2
        self.rg = np.linspace(0, self.rmax, 600)
        self.table = self._h(self.rg[:, None], self.zg[None, :])          # (r, z), even in z
        self.H = np.trapezoid(2 * np.pi * self.rg[:, None] * self.table, self.rg, axis=0)   # plane-integrated response, um^2
        self.onaxis = self.table[0]
        self.Veff = 2 * np.trapezoid(self.H, self.zg)                      # effective detection volume, um^3
        return self

    def w(self, z):
        return self.w0 * np.sqrt(1 + (z / self.zR) ** 2)

    def s_det(self, z):
        return self.s_em * np.sqrt(1 + (z / self.zR_em) ** 2)

    def _h(self, rho, z):
        wz = self.w(z)
        I = (self.w0 / wz) ** 2 * np.exp(-2 * rho ** 2 / wz ** 2)
        s = self.s_det(z)
        D = ncx2.cdf((self.a / s) ** 2, 2, np.maximum((rho / s) ** 2, 1e-12))
        return I * D

    # --- summary numbers ------------------------------------------------------
    def fwhm_z_onaxis(self):
        f = self.onaxis / self.onaxis[0]
        i = np.argmax(f < 0.5)
        return 2 * self.zg[i] if i > 0 else 2 * self.zmax

    def fwhm_z_sea(self):
        f = self.H / self.H[0]
        i = np.argmax(f < 0.5)
        return 2 * self.zg[i] if i > 0 else 2 * self.zmax

    def fwhm_xy(self):
        f = self.table[:, 0] / self.table[0, 0]
        i = np.argmax(f < 0.5)
        return 2 * self.rg[i]

    def D00(self):
        return float(self.table[0, 0])

    def radial(self, z):
        """h(rho, z) as a function of rho (callable on arrays)."""
        iz = min(int(round(abs(z) / self.dz)), len(self.zg) - 1)
        col = self.table[:, iz]
        return lambda rho: np.interp(rho, self.rg, col, right=0.0)

    def Hz(self, z):
        return np.interp(np.abs(z), self.zg, self.H, right=0.0)


def fib_sphere(n):
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    theta = np.pi * (1 + 5 ** 0.5) * i
    return np.stack([np.cos(theta) * np.sin(phi), np.sin(theta) * np.sin(phi), np.cos(phi)], axis=1)


def emission_rate_per_molecule(fluo, laser_uW, w0_um, lam_ex=0.561):
    """Photons emitted per second by one PE at the centre of the focal spot (saturable 2-level)."""
    w0 = w0_um * 1e-6
    I0 = 2 * laser_uW * 1e-6 / (np.pi * w0 ** 2)         # W/m^2 peak irradiance of a Gaussian beam
    e_ph = H_PLANCK * C_LIGHT / (lam_ex * 1e-6)
    k_ex = fluo.sigma_abs_m2 * I0 / e_ph
    k_em = fluo.QY * k_ex / (1 + k_ex * fluo.tau_fl_s)
    return k_em, k_ex, I0


def absorbed_per_frame(fluo, laser_uW, dwell_us, px_um, lam_ex=0.561):
    """Photons absorbed by one PE anywhere in the scanned volume during one full raster frame (linear regime)."""
    e_ph = H_PLANCK * C_LIGHT / (lam_ex * 1e-6)
    fluence = laser_uW * 1e-6 * dwell_us * 1e-6 / (px_um * 1e-6) ** 2    # J/m^2
    return fluo.sigma_abs_m2 * fluence / e_ph


def bleach_fraction_per_frame(fluo, laser_uW, dwell_us, px_um, lam_ex=0.561):
    return 1 - np.exp(-fluo.phi_bleach * absorbed_per_frame(fluo, laser_uW, dwell_us, px_um, lam_ex))


@dataclass
class ScanSettings:
    objective: str = '20x'
    pinhole_AU: float = 1.0
    px_per_bead: float = 20.0       # pixels across the bead diameter (sets pixel size = 2R/px_per_bead)
    dwell_us: float = 2.0
    laser_uW: float = 10.0          # power at the sample
    gain: float = 20.0              # DN per photoelectron (PMT HV + amplifier, lumped)
    excess_noise_F: float = 1.3     # PMT multiplication excess-noise factor
    offset_DN: float = 200.0
    read_noise_DN: float = 3.0
    adc_max: int = 65535
    transmission: float = 0.4       # optics x filters
    QE: float = 0.40                # GaAsP at ~580 nm
    lam_ex: float = 0.561
    fast_axis_smear: bool = True


@dataclass
class BeadState:
    R_um: float = 4.0
    sigma_PE_um2: float = 1000.0    # uniform PE surface density before bleaching
    z0_um: float = 0.0              # focal plane offset from the bead centre
    xy_off_px: tuple = (0.0, 0.0)   # bead centre offset from a pixel centre (sub-pixel phase), in pixels
    field_r: float = 0.0            # normalised radial position in the field of view (0 centre, 1 edge)
    vignette: float = 0.0           # fractional illumination*collection loss at the field edge (~ (1-v r^2))
    field_curv_um: float = 0.0      # extra focal offset at the field edge (z0_eff = z0 + c r^2)
    frames_before: int = 0          # frames already acquired (bleaching dose), e.g. a focus z-series
    kind: str = 'shell'             # 'shell' or 'volume' (uniformly stained core, for the signature contrast)
    autofluor_PE_um3: float = 0.0   # bead-body autofluorescence, PE-equivalents per um^3 of bead volume
    solution_PE_nM: float = 0.0     # free PE-antibody left in the imaging buffer (no-wash / incomplete wash), nM


def render(bead, scan, fluo=PE, fov_px=48, oversample=8, n_points=60000, seed=0, noise=True, slab_um=0.1):
    """Simulate one confocal frame of one bead.  Returns a dict with the image (DN), the noise-free photon map,
    the metrics and the derived optical constants."""
    rng = np.random.default_rng(seed)
    obj = OBJ[scan.objective]
    psf = ConfocalPSF(obj, scan.pinhole_AU, scan.lam_ex, fluo.lam_em_um)
    px = 2 * bead.R_um / scan.px_per_bead
    fine = px / oversample
    N = fov_px * oversample
    # --- shell / volume point cloud ---------------------------------------------------------------
    if bead.kind == 'shell':
        pts = fib_sphere(n_points) * bead.R_um
        dA = 4 * np.pi * bead.R_um ** 2 / n_points
        weights = np.full(n_points, bead.sigma_PE_um2 * dA)                 # PE per point
    else:
        u = rng.random((n_points, 3)) * 2 - 1
        u = u[np.sum(u ** 2, axis=1) <= 1.0] * bead.R_um
        pts = u
        total = bead.sigma_PE_um2 * 4 * np.pi * bead.R_um ** 2
        weights = np.full(len(pts), total / len(pts))
    dose = absorbed_per_frame(fluo, scan.laser_uW, scan.dwell_us, px, scan.lam_ex)
    surv = np.exp(-fluo.phi_bleach * dose * bead.frames_before)
    weights = weights * surv
    if bead.autofluor_PE_um3 > 0:        # bead body glows uniformly (assumed not to bleach)
        u = rng.random((n_points // 2, 3)) * 2 - 1
        u = u[np.sum(u ** 2, axis=1) <= 1.0] * bead.R_um
        pts = np.concatenate([pts, u])
        weights = np.concatenate([weights, np.full(len(u), bead.autofluor_PE_um3 * 4 / 3 * np.pi * bead.R_um ** 3 / len(u))])
    z0 = bead.z0_um + bead.field_curv_um * bead.field_r ** 2
    # --- lateral positions on the fine grid ---------------------------------------------------------
    cx = (fov_px / 2 + bead.xy_off_px[0]) * px
    cy = (fov_px / 2 + bead.xy_off_px[1]) * px
    ix = np.floor((pts[:, 0] + cx) / fine).astype(int)
    iy = np.floor((pts[:, 1] + cy) / fine).astype(int)
    ok = (ix >= 0) & (ix < N) & (iy >= 0) & (iy < N)
    ix, iy, wts, zz = ix[ok], iy[ok], weights[ok], pts[ok, 2] - z0        # zz = defocus of each point
    # --- z-slab accumulation, defocus-dependent lateral kernel, summed in Fourier space -------------
    zmax = np.abs(zz).max() + slab_um
    rk = min(2.5 * psf.w(zmax), psf.a + 3.5 * psf.s_det(zmax)) + 0.2
    K = int(np.ceil(rk / fine))
    P = next_fast_len(N + 2 * K + 2)
    ky, kx = np.mgrid[-K:K + 1, -K:K + 1]
    krho = np.hypot(kx, ky) * fine
    F = np.zeros((P, P // 2 + 1), dtype=complex)
    slab = np.round(zz / slab_um).astype(int)
    for s in np.unique(slab):
        sel = slab == s
        hist = np.zeros((P, P))
        np.add.at(hist, (iy[sel], ix[sel]), wts[sel])
        kern = np.zeros((P, P))
        kk = psf.radial(s * slab_um)(krho)
        kern[:2 * K + 1, :2 * K + 1] = kk
        kern = np.roll(kern, (-K, -K), axis=(0, 1))
        F += rfft2(hist) * rfft2(kern)
    grid = irfft2(F, s=(P, P))[:N, :N]
    if scan.fast_axis_smear:
        grid = ndimage.uniform_filter1d(grid, oversample, axis=1, mode='constant')
    eff_PE = np.maximum(grid[oversample // 2::oversample, oversample // 2::oversample], 0.0)   # PE-equivalents at the focus
    # --- photons ------------------------------------------------------------------------------------
    k_em, k_ex, I0 = emission_rate_per_molecule(fluo, scan.laser_uW, psf.w0, scan.lam_ex)
    eta = obj.collection_fraction() * scan.transmission * scan.QE
    vig = 1.0 - bead.vignette * bead.field_r ** 2
    bg_PE = bead.solution_PE_nM * 0.6022 * psf.Veff                            # free PE in the detection volume (PE-equivalents)
    lam = (eff_PE + bg_PE) * k_em * eta * scan.dwell_us * 1e-6 * vig          # mean photoelectrons / pixel
    if noise:
        ne = rng.poisson(lam).astype(float)
        mult = ne * scan.gain + rng.normal(0, 1, ne.shape) * scan.gain * np.sqrt(np.maximum(ne, 0) * (scan.excess_noise_F - 1))
        dn = scan.offset_DN + mult + rng.normal(0, scan.read_noise_DN, ne.shape)
        img = np.clip(np.round(dn), 0, scan.adc_max)
    else:
        img = scan.offset_DN + lam * scan.gain
    out = dict(image=img, mean_pe=lam, eff_PE=eff_PE, px_um=px, fwhm_xy=psf.fwhm_xy(), fwhm_z=psf.fwhm_z_onaxis(),
               fwhm_z_sea=psf.fwhm_z_sea(), pinhole_um=2 * psf.a, D00=psf.D00(), Veff_um3=psf.Veff, bg_PE_per_px=bg_PE,
               k_em=k_em, k_ex=k_ex, I0_W_m2=I0, eta=eta, bleach_dose_per_frame=dose, survival=surv,
               bleach_frac_per_frame=1 - np.exp(-fluo.phi_bleach * dose), obj=obj.name,
               centre_px=((fov_px / 2 + bead.xy_off_px[0]), (fov_px / 2 + bead.xy_off_px[1])),
               total_PE=float(np.sum(weights)))
    out.update(metrics(out, bead, scan))
    return out


def radial_profile(img, centre, px_um, dr_um=None):
    yy, xx = np.indices(img.shape)
    r = np.hypot(xx - centre[0], yy - centre[1]) * px_um
    dr = dr_um or px_um
    bins = np.arange(0, r.max() + dr, dr)
    idx = np.digitize(r.ravel(), bins) - 1
    cnt = np.bincount(idx, minlength=len(bins))
    prof = np.bincount(idx, weights=img.ravel(), minlength=len(bins)) / np.maximum(cnt, 1)
    prof[cnt == 0] = np.nan
    return bins[:-1] + dr / 2, prof[:-1]


def metrics(out, bead, scan):
    """Integrated (bead mask, background-subtracted), ring-mean, rim-peak, and a shot-noise SNR estimate."""
    img, px, c = out['image'], out['px_um'], out['centre_px']
    yy, xx = np.indices(img.shape)
    r = np.hypot(xx - c[0], yy - c[1]) * px
    margin = 2.5
    mask = r <= bead.R_um + margin
    bgmask = r >= bead.R_um + margin + px
    bg = np.median(img[bgmask]) if bgmask.any() else scan.offset_DN
    integrated = float(np.sum(img[mask] - bg))
    rr, prof = radial_profile(img - bg, c, px)
    inside = (rr <= bead.R_um + margin) & np.isfinite(prof)
    rr, prof = rr[inside], prof[inside]
    # ring position from a smoothed, finely interpolated profile (robust to the sampling phase)
    rf = np.linspace(rr[0], rr[-1], 400)
    pf = np.interp(rf, rr, prof)
    pf = np.convolve(pf, np.ones(21) / 21, mode='same')
    i_pk = int(np.argmax(pf))
    ring_r = float(rf[i_pk])
    ring_mask = (np.abs(r - ring_r) <= 0.5) & mask            # 1-um-wide annulus centred on the rim
    ring_mean = float(np.mean(img[ring_mask] - bg)) if ring_mask.any() else 0.0
    peak = float(np.nanmax(prof))
    centre_mean = float(np.mean(img[r <= 0.3 * bead.R_um] - bg))
    lam = out['mean_pe'][mask]
    var = scan.excess_noise_F * np.sum(lam) + mask.sum() * (scan.read_noise_DN / scan.gain) ** 2
    snr_int = float(np.sum(lam) / np.sqrt(var)) if var > 0 else 0.0
    sat_frac = float(np.mean(img[mask] >= scan.adc_max - 1))
    return dict(bg=float(bg), integrated=integrated, ring_r_um=ring_r, ring_mean=ring_mean, peak=peak,
                centre_mean=centre_mean, contrast=(peak / centre_mean if centre_mean > 0 else np.inf),
                snr_integrated=snr_int, n_mask_px=int(mask.sum()), photons_in_mask=float(np.sum(lam)),
                saturated_frac=sat_frac, profile=(rr, prof))


def integrated_analytic(bead, scan, fluo=PE):
    """Noise-free integrated photoelectrons for a uniform shell: hat-box theorem (shell area between z and
    z+dz is 2 pi R dz) x plane-integrated PSF response H(z) / pixel area."""
    obj = OBJ[scan.objective]
    psf = ConfocalPSF(obj, scan.pinhole_AU, scan.lam_ex, fluo.lam_em_um)
    px = 2 * bead.R_um / scan.px_per_bead
    z = np.linspace(-bead.R_um, bead.R_um, 4001)
    z0 = bead.z0_um + bead.field_curv_um * bead.field_r ** 2
    axial = np.trapezoid(psf.Hz(z - z0), z)
    k_em, _, _ = emission_rate_per_molecule(fluo, scan.laser_uW, psf.w0, scan.lam_ex)
    eta = obj.collection_fraction() * scan.transmission * scan.QE
    return bead.sigma_PE_um2 * 2 * np.pi * bead.R_um * axial / px ** 2 * k_em * eta * scan.dwell_us * 1e-6


def ring_profile_analytic(rho, R, z0, w):
    """Projected surface density of a thin shell before lateral blur, for an axial weighting w(z)."""
    rho = np.asarray(rho, float)
    out = np.zeros_like(rho)
    ok = rho < R
    h = np.sqrt(R ** 2 - rho[ok] ** 2)
    out[ok] = R / h * (w(h - z0) + w(-h - z0))
    return out


if __name__ == '__main__':
    import time
    for key in ('10x', '20x', '20xD'):
        for AU in (0.5, 1, 2, 4):
            p = ConfocalPSF(OBJ[key], AU)
            fxy, fz, PH = psf_fwhm_zeiss(OBJ[key], AU)
            print('%-28s %4.1f AU  pinhole %.2f um  xy %.2f  z(on-axis) %.2f  z(sea) %.2f  in-focus pass %.2f   [Zeiss: xy %.2f z %.2f]' % (
                OBJ[key].name, AU, 2 * p.a, p.fwhm_xy(), p.fwhm_z_onaxis(), p.fwhm_z_sea(), p.D00(), fxy, fz))
    scan = ScanSettings()
    for z0 in (0, 1, 2, 3, 3.5):
        t = time.time()
        r = render(BeadState(z0_um=z0), scan, noise=False)
        print('z0=%.1f  integrated=%.4g  analytic=%.4g  ring_r=%.2f  peak=%.4g  centre=%.4g  (%.2fs)' % (
            z0, r['integrated'] / scan.gain, integrated_analytic(BeadState(z0_um=z0), scan), r['ring_r_um'], r['peak'] / scan.gain, r['centre_mean'] / scan.gain, time.time() - t))
