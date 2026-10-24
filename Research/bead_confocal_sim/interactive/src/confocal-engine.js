/* confocal-engine.js — the image of a PE SHELL on an 8 µm bead, one pinhole-set plane, Nikon AX R.
   A port of Research/bead_confocal_sim/optics.py (checked against it by tools/check_confocal.mjs), with two changes:
     1. saturation is computed point by point in the focal volume (each molecule sees its own irradiance), not with
        the beam-peak rate for every molecule; this is what moves the 5 %-sublinear power to ≈ 2 µW at 20x (report B.4.2);
     2. free PE in the buffer is excluded from the volume the bead occupies (report B.4.6), so a no-wash image shows
        the bead as a dark hole in a bright background.
   PSF h(ρ, z) = excitation (Gaussian beam, waist 0.433 λex/NA, Rayleigh range π w0² n/λex) × pinhole pass (the share
   of the molecule's defocused emission spot, a Gaussian of width s(z), that falls inside the pinhole of radius
   a = AU · 1.22 λem/NA / 2 at the sample). Normalised so a molecule at the focus behind an open pinhole gives 1. */
'use strict';
const CONFOCAL = (() => {
  const H_PL = 6.62607015e-34, C_L = 2.99792458e8, N_S = 1.33;
  const OBJ = {
    '10x': { key: '10x', name: 'Plan Apo λ 10x/0.45', M: 10, NA: 0.45 },
    '20x': { key: '20x', name: 'Plan Apo λ 20x/0.75', M: 20, NA: 0.75 },
    '20xD': { key: '20xD', name: 'Plan Apo λD 20x/0.80', M: 20, NA: 0.80 },
  };
  /* R-PE: ε at 561 nm, quantum yield, fluorescence lifetime (2.7 ns, report B.4.1), photodestruction quantum yield
     (White & Stryer 1987: 1.1e-5; 6.5e-6 with n-propyl gallate), emission wavelength used for the pinhole */
  const PE = { eps: 1.96e6, QY: 0.82, tau: 2.7e-9, phi: 1.1e-5, phiNPG: 6.5e-6, lamEm: 0.578, lamEx: 0.561 };
  const sigmaM2 = () => 3.82e-21 * PE.eps * 1e-4;
  const collection = o => { const s = Math.min(o.NA / N_S, 1); return 0.5 * (1 - Math.sqrt(1 - s * s)); };
  const airyUm = o => 1.22 * PE.lamEm / o.NA;

  /* exp(−x)·I0(x), x ≥ 0 (Abramowitz & Stegun 9.8.1–9.8.2, |ε| < 2e-7) */
  function i0e(x) {
    if (x < 3.75) { const t = x / 3.75, q = t * t; return Math.exp(-x) * (1 + q * (3.5156229 + q * (3.0899424 + q * (1.2067492 + q * (0.2659732 + q * (0.0360768 + q * 0.0045813)))))); }
    const t = 3.75 / x;
    return (0.39894228 + t * (0.01328592 + t * (0.00225319 + t * (-0.00157565 + t * (0.00916281 + t * (-0.02057706 + t * (0.02635537 + t * (-0.01647633 + t * 0.00392377)))))))) / Math.sqrt(x);
  }
  /* 16-point Gauss–Legendre nodes and weights on [−1, 1] */
  const GL = (() => {
    const n = 16, x = [], w = [];
    for (let i = 1; i <= n; i++) {
      let z = Math.cos(Math.PI * (i - 0.25) / (n + 0.5)), pp = 0;
      for (let it = 0; it < 50; it++) { let p1 = 1, p2 = 0; for (let j = 1; j <= n; j++) { const p3 = p2; p2 = p1; p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j; } pp = n * (z * p1 - p2) / (z * z - 1); const dz = p1 / pp; z -= dz; if (Math.abs(dz) < 1e-15) break; }
      x.push(z); w.push(2 / ((1 - z * z) * pp * pp));
    }
    return { x, w };
  })();
  /* P(|X| ≤ a) for a 2-D Gaussian of width s centred at distance ρ — scipy's ncx2.cdf((a/s)², 2, (ρ/s)²) */
  function pinholePass(rho, s, a) {
    const lo = Math.max(0, rho - 8 * s), hi = Math.min(a, rho + 8 * s);
    if (hi <= lo) return 0;
    const panels = Math.max(1, Math.ceil((hi - lo) / (2.5 * s))), L = (hi - lo) / panels, s2 = s * s;
    let sum = 0;
    for (let p = 0; p < panels; p++) {
      const a0 = lo + p * L, c = a0 + L / 2, hw = L / 2;
      for (let i = 0; i < 16; i++) { const r = c + hw * GL.x[i], d = r - rho; sum += GL.w[i] * hw * (r / s2) * Math.exp(-d * d / (2 * s2)) * i0e(r * rho / s2); }
    }
    return Math.min(1, sum);
  }

  /* ---------- the PSF table ---------- */
  const cache = new Map();
  function psf(objKey, AU) {
    const key = objKey + ':' + AU;
    if (cache.has(key)) return cache.get(key);
    const o = OBJ[objKey], NA = o.NA, lx = PE.lamEx, lm = PE.lamEm;
    const w0 = 0.433 * lx / NA, zR = Math.PI * w0 * w0 * N_S / lx;
    const sEm = 0.51 * lm / NA / 2.3548, zRem = Math.PI * (2 * sEm) ** 2 * N_S / lm;
    const a = AU * airyUm(o) / 2;
    const w = z => w0 * Math.sqrt(1 + (z / zR) ** 2), sd = z => sEm * Math.sqrt(1 + (z / zRem) ** 2);
    const zmax = 14, dz = 0.05, nz = Math.round(zmax / dz) + 1;
    const rmax = Math.min(2.5 * w(zmax), a + 3.5 * sd(zmax)) + 0.2, nr = 420, dr = rmax / (nr - 1);
    const Itab = new Float32Array(nr * nz), Dtab = new Float32Array(nr * nz), rk = new Float32Array(nz);
    for (let iz = 0; iz < nz; iz++) {
      const z = iz * dz, wz = w(z), s = sd(z), f = (w0 / wz) ** 2;
      rk[iz] = Math.min(2.5 * wz, a + 3.5 * s) + 0.2;
      for (let ir = 0; ir < nr; ir++) { const rho = ir * dr, i = iz * nr + ir; Itab[i] = f * Math.exp(-2 * rho * rho / (wz * wz)); Dtab[i] = pinholePass(rho, s, a); }
    }
    const P = { o, AU, w0, zR, sEm, zRem, a, w, sd, zmax, dz, nz, rmax, nr, dr, Itab, Dtab, rk, k0: null, htab: new Float32Array(nr * nz), H: new Float64Array(nz), onaxis: new Float64Array(nz), Veff: 0 };
    setSaturation(P, 0);
    cache.set(key, P);
    return P;
  }
  /* h = I/(1 + k0·I)·D with k0 = k_ex·τ at the beam peak (0 = linear); H(z) = ∫2πρ h dρ; Veff = 2∫H dz over |z| ≤ 14 µm */
  function setSaturation(P, k0) {
    if (P.k0 === k0) return P;
    P.k0 = k0;
    const { nr, nz, dr, dz, Itab, Dtab, htab, H, onaxis } = P;
    for (let i = 0; i < nr * nz; i++) { const I = Itab[i]; htab[i] = I / (1 + k0 * I) * Dtab[i]; }
    let V = 0;
    for (let iz = 0; iz < nz; iz++) {
      let s = 0; const b = iz * nr;
      for (let ir = 1; ir < nr; ir++) s += 0.5 * dr * (2 * Math.PI) * ((ir - 1) * dr * htab[b + ir - 1] + ir * dr * htab[b + ir]);
      H[iz] = s; onaxis[iz] = htab[b];
      if (iz) V += 0.5 * dz * (H[iz - 1] + H[iz]);
    }
    P.Veff = 2 * V;
    return P;
  }
  function hAt(P, rho, az) {
    if (rho >= P.rmax || az >= P.zmax) return 0;
    const fz = az / P.dz, iz = Math.min(fz | 0, P.nz - 2), tz = fz - iz, fr = rho / P.dr, ir = Math.min(fr | 0, P.nr - 2), tr = fr - ir, n = P.nr, T = P.htab, i = iz * n + ir;
    return (1 - tz) * ((1 - tr) * T[i] + tr * T[i + 1]) + tz * ((1 - tr) * T[i + n] + tr * T[i + n + 1]);
  }
  function Hat(P, z) { const az = Math.abs(z); if (az >= P.zmax) return 0; const f = az / P.dz, i = Math.min(f | 0, P.nz - 2), t = f - i; return (1 - t) * P.H[i] + t * P.H[i + 1]; }
  function rkAt(P, az) { const i = Math.min(Math.round(az / P.dz), P.nz - 1); return P.rk[i]; }
  function widths(P) {
    const half = (arr, step) => { const v0 = arr[0]; for (let i = 1; i < arr.length; i++) if (arr[i] < 0.5 * v0) { const t = (arr[i - 1] - 0.5 * v0) / (arr[i - 1] - arr[i]); return 2 * (i - 1 + t) * step; } return 2 * (arr.length - 1) * step; };
    const row0 = Array.from(P.htab.subarray(0, P.nr));
    return { xy: half(row0, P.dr), zOnAxis: half(Array.from(P.onaxis), P.dz), zPlane: half(Array.from(P.H), P.dz), D00: P.Dtab[0], Veff: P.Veff, pinholeUm: 2 * P.a };
  }
  /* textbook (Zeiss/Pawley) FWHM estimates, as optics.psf_fwhm_zeiss */
  function zeiss(objKey, AU) {
    const o = OBJ[objKey], n = 1.0, NA = o.NA, lb = Math.SQRT2 * PE.lamEx * PE.lamEm / Math.sqrt(PE.lamEx ** 2 + PE.lamEm ** 2), PH = AU * airyUm(o), den = n - Math.sqrt(n * n - NA * NA);
    if (AU <= 0.25) return { xy: 0.37 * lb / NA, z: 0.64 * lb / den };
    return { xy: 0.51 * PE.lamEm / NA, z: Math.sqrt((0.88 * PE.lamEm / den) ** 2 + (Math.SQRT2 * n * PH / NA) ** 2) };
  }

  /* ---------- the bead's own optics (geometric ray trace, tools/ray_table.json) ---------- */
  let RAY = null;
  function setRayTable(t) { RAY = t; }
  function materialFactor(objKey, material, withExcitation) {
    if (!RAY || !material || material === 'matched') return null;
    const zs = RAY.zs, c = RAY.c[objKey] && RAY.c[objKey][material]; if (!c) return null;
    const p = withExcitation ? 2 : 1;
    return z => { if (z <= zs[0]) return c[0] ** p; if (z >= zs[zs.length - 1]) return c[c.length - 1] ** p; const f = (z - zs[0]) / (zs[1] - zs[0]), i = Math.min(f | 0, zs.length - 2), t = f - i; return ((1 - t) * c[i] + t * c[i + 1]) ** p; };
  }

  /* ---------- radial profiles (PE-equivalents at the focus, per unit density) ---------- */
  function ringIntegral(P, r, rp, az, n) {
    // ∫0^2π h(|r − ρ'|, z) dφ, restricted to where the PSF reaches
    if (r * rp < 1e-12) return 2 * Math.PI * hAt(P, Math.sqrt(r * r + rp * rp), az);
    const rk = rkAt(P, az), C = (r * r + rp * rp - rk * rk) / (2 * r * rp);
    if (C >= 1) return 0;
    const pm = C <= -1 ? Math.PI : Math.acos(C), hp = pm / n, a = r * r + rp * rp, b = 2 * r * rp;
    let s = 0;
    for (let j = 0; j <= n; j++) { const f = hAt(P, Math.sqrt(Math.max(0, a - b * Math.cos(j * hp))), az); s += f * (j === 0 || j === n ? 1 : (j & 1 ? 4 : 2)); }
    return 2 * s * hp / 3;
  }
  /** shell of radius R, unit surface density (1 PE/µm²); cz(z) = optional emission factor by height on the shell */
  function shellProfile(P, R, z0, rs, cz, nT = 360, nPhi = 24) {
    const out = new Float64Array(rs.length);
    for (let it = 0; it < nT; it++) {
      const th = (it + 0.5) * Math.PI / nT, zp = R * Math.cos(th), rp = R * Math.sin(th), az = Math.abs(zp - z0);
      if (az >= P.zmax) continue;
      const wgt = R * R * Math.sin(th) * (Math.PI / nT) * (cz ? cz(zp) : 1);
      for (let k = 0; k < rs.length; k++) out[k] += wgt * ringIntegral(P, rs[k], rp, az, nPhi);
    }
    return out;
  }
  /** solid sphere of radius R, unit volume density (1 PE/µm³) — also the bead's excluded volume for the buffer */
  function coreProfile(P, R, z0, rs, nZ = 72, nRho = 26, nPhi = 16) {
    const out = new Float64Array(rs.length), dzp = 2 * R / nZ;
    for (let iz = 0; iz < nZ; iz++) {
      const zp = -R + (iz + 0.5) * dzp, rm = Math.sqrt(Math.max(0, R * R - zp * zp)), az = Math.abs(zp - z0);
      if (az >= P.zmax || rm <= 0) continue;
      const drp = rm / nRho;
      for (let ir = 0; ir < nRho; ir++) {
        const rp = (ir + 0.5) * drp, wgt = rp * drp * dzp;
        for (let k = 0; k < rs.length; k++) out[k] += wgt * ringIntegral(P, rs[k], rp, az, nPhi);
      }
    }
    return out;
  }
  /* hat-box: the whole-plane integral of a shell's image = 2πR·σ·∫ H(z − z0)·c(z) dz; a filled bead: ∫ π(R² − z²)·H dz */
  function Fshell(P, R, z0, cz) { const n = 800, d = 2 * R / n; let s = 0; for (let i = 0; i <= n; i++) { const z = -R + i * d; s += (i === 0 || i === n ? 0.5 : 1) * Hat(P, z - z0) * (cz ? cz(z) : 1); } return 2 * Math.PI * R * s * d; }
  function Fcore(P, R, z0) { const n = 800, d = 2 * R / n; let s = 0; for (let i = 0; i <= n; i++) { const z = -R + i * d; s += (i === 0 || i === n ? 0.5 : 1) * Math.PI * (R * R - z * z) * Hat(P, z - z0); } return s * d; }

  /* ---------- photons ---------- */
  function excitation(uW, w0um) {
    const w0 = w0um * 1e-6, I0 = 2 * uW * 1e-6 / (Math.PI * w0 * w0), eph = H_PL * C_L / (PE.lamEx * 1e-6), kex = sigmaM2() * I0 / eph;
    return { I0, kex, k0: kex * PE.tau, flux: I0 / eph };
  }
  function absorbedPerFrame(uW, dwellUs, pxUm) { const eph = H_PL * C_L / (PE.lamEx * 1e-6); return sigmaM2() * (uW * 1e-6 * dwellUs * 1e-6 / (pxUm * 1e-6) ** 2) / eph; }

  /* ---------- one frame ---------- */
  function interp(rs, I, r) { const dr = rs[1] - rs[0], f = r / dr, i = f | 0; if (i >= rs.length - 1) return I[rs.length - 1]; const t = f - i; return (1 - t) * I[i] + t * I[i + 1]; }
  /**
   * bead: {R, sigma (PE/µm²), z0, offX, offY (px), fieldR (0..1), vignette, curv (µm at the edge), framesBefore, kind 'shell'|'core',
   *        material 'matched'|'silica'|'pmma'|'ps', excite (bool), autofluor (PE/µm³), solutionNM}
   * scan: {obj, AU, ppb, dwell (µs), uW, gain (DN per photoelectron), enf, offset (DN), read (DN), bits, transmission, QE, avg, antifade, noise, seed}
   */
  function render(bead, scan, RNG) {
    const P = psf(scan.obj, scan.AU), o = P.o, ex = excitation(scan.uW, P.w0);
    setSaturation(P, ex.k0);
    const R = bead.R, px = 2 * R / scan.ppb, half = Math.max(12, Math.min(90, Math.ceil((R + 2.5 + 3 * px + 1.0) / px))), fov = 2 * half;
    const z0 = bead.z0 + (bead.curv || 0) * (bead.fieldR || 0) ** 2, vig = 1 - (bead.vignette || 0) * (bead.fieldR || 0) ** 2;
    const dose = absorbedPerFrame(scan.uW, scan.dwell, px), phi = scan.antifade ? PE.phiNPG : PE.phi, N = Math.max(1, scan.avg | 0);
    const surv0 = Math.exp(-phi * dose * (bead.framesBefore || 0)); let survAvg = 0; for (let k = 0; k < N; k++) survAvg += Math.exp(-phi * dose * k) / N;
    const surv = surv0 * survAvg;
    const cx = half + (bead.offX || 0), cy = half + (bead.offY || 0);
    const rEnd = Math.hypot(half + Math.abs(bead.offX || 0) + 1, half + Math.abs(bead.offY || 0) + 1) * px, dr = Math.min(0.05, px / 5), nR = Math.ceil(rEnd / dr) + 2;
    const rs = new Float64Array(nR); for (let i = 0; i < nR; i++) rs[i] = i * dr;
    const cz = bead.kind === 'core' ? null : materialFactor(scan.obj, bead.material, bead.excite);
    let sig;
    const needCore = bead.kind === 'core' || bead.solutionNM > 0 || bead.autofluor > 0;
    const Vb = needCore ? coreProfile(P, R, z0, rs) : null;
    if (bead.kind === 'core') { const nv = bead.sigma * 4 * Math.PI * R * R / (4 / 3 * Math.PI * R ** 3); sig = Vb.map(v => v * nv); }
    else { const s = shellProfile(P, R, z0, rs, cz); sig = s.map(v => v * bead.sigma); }
    const prof = new Float64Array(nR);
    for (let i = 0; i < nR; i++) prof[i] = sig[i] * surv + (bead.autofluor || 0) * (Vb ? Vb[i] : 0) + (bead.solutionNM || 0) * 0.6022 * (P.Veff - (Vb ? Vb[i] : 0));
    const eta = collection(o) * scan.transmission * scan.QE, k1 = PE.QY * ex.kex * eta * scan.dwell * 1e-6 * vig;   // photoelectrons per PE-equivalent per frame
    const lam = new Float64Array(fov * fov), img = new Float64Array(fov * fov), adc = Math.pow(2, scan.bits) - 1;
    const S = [-3, -2, -1, 0, 1, 2, 3].map(k => k / 7);
    for (let j = 0; j < fov; j++) for (let i = 0; i < fov; i++) {
      const y = (j - cy) * px; let s = 0;
      for (const d of S) { const x = (i - cx + d) * px; s += interp(rs, prof, Math.sqrt(x * x + y * y)); }
      lam[j * fov + i] = Math.max(0, s / S.length) * k1;
    }
    const rnd = RNG || null;
    for (let p = 0; p < fov * fov; p++) {
      let dn;
      if (scan.noise && rnd) {
        const ne = rnd.poisson(N * lam[p]);
        const mult = ne * scan.gain + rnd.normal() * scan.gain * Math.sqrt(Math.max(0, ne * (scan.enf - 1)));
        dn = (N * scan.offset + mult + rnd.normal() * scan.read * Math.sqrt(N)) / N;
      } else dn = scan.offset + lam[p] * scan.gain;
      img[p] = Math.max(0, Math.min(adc, Math.round(dn)));
    }
    const out = { img, lam, fov, px, cx, cy, rs, prof, sig, Vb, adc, P, ex, eta, k1, dose, surv, survAvg, surv0, z0eff: z0, vig, N,
      bleachPerFrame: 1 - Math.exp(-phi * dose), widths: widths(P), zeiss: zeiss(scan.obj, scan.AU), totalPE: bead.sigma * 4 * Math.PI * R * R };
    out.m = metrics(out, bead, scan);
    out.Fanalytic = (bead.kind === 'core' ? bead.sigma * 4 * Math.PI * R * R / (4 / 3 * Math.PI * R ** 3) * Fcore(P, R, z0) : bead.sigma * Fshell(P, R, z0, cz)) * surv / (px * px) * k1;
    return out;
  }
  /* integrated (bead mask, annulus background subtracted), ring mean, rim peak, centre, SNR — as optics.metrics */
  function metrics(out, bead, scan) {
    const { img, lam, fov, px, cx, cy } = out, R = bead.R, margin = 2.5, n = fov * fov, rr = new Float64Array(n);
    for (let j = 0; j < fov; j++) for (let i = 0; i < fov; i++) rr[j * fov + i] = Math.hypot(i - cx, j - cy) * px;
    const bgv = []; for (let p = 0; p < n; p++) if (rr[p] >= R + margin + px) bgv.push(img[p]);
    bgv.sort((a, b) => a - b);
    const bg = bgv.length ? (bgv.length % 2 ? bgv[(bgv.length - 1) / 2] : 0.5 * (bgv[bgv.length / 2 - 1] + bgv[bgv.length / 2])) : scan.offset;
    let integ = 0, nm = 0, lsum = 0, sat = 0, cs = 0, cn = 0;
    for (let p = 0; p < n; p++) if (rr[p] <= R + margin) { integ += img[p] - bg; nm++; lsum += lam[p]; if (img[p] >= out.adc - 1) sat++; if (rr[p] <= 0.3 * R) { cs += img[p] - bg; cn++; } }
    // radial profile, bins of one pixel
    const nb = Math.ceil((R + margin) / px) + 1, ps = new Float64Array(nb), pc = new Float64Array(nb);
    for (let p = 0; p < n; p++) { if (rr[p] > R + margin) continue; const b = Math.floor(rr[p] / px); if (b < nb) { ps[b] += img[p] - bg; pc[b]++; } }
    const pr = [], pv = [];
    for (let b = 0; b < nb; b++) if (pc[b]) { pr.push((b + 0.5) * px); pv.push(ps[b] / pc[b]); }
    let peak = -Infinity; pv.forEach(v => { if (v > peak) peak = v; });
    // ring radius from a smoothed, finely interpolated profile (as the Python)
    const M = 400, rf = [], pf = [];
    for (let i = 0; i < M; i++) { const r = pr[0] + (pr[pr.length - 1] - pr[0]) * i / (M - 1); rf.push(r); let k = 0; while (k < pr.length - 2 && pr[k + 1] < r) k++; const t = (r - pr[k]) / (pr[k + 1] - pr[k] || 1); pf.push((1 - t) * pv[k] + t * pv[k + 1]); }
    let best = -Infinity, ringR = 0;
    for (let i = 0; i < M; i++) { let s = 0; for (let k = -10; k <= 10; k++) { const q = i + k; if (q >= 0 && q < M) s += pf[q]; } if (s > best) { best = s; ringR = rf[i]; } }
    let rsum = 0, rn = 0; for (let p = 0; p < n; p++) if (Math.abs(rr[p] - ringR) <= 0.5 && rr[p] <= R + margin) { rsum += img[p] - bg; rn++; }
    const N = out.N, varPe = scan.enf * N * lsum + nm * (scan.read / scan.gain) ** 2;   // photoelectrons², N frames summed
    const centre = cn ? cs / cn : 0;
    return { bg, integrated: integ, integratedPe: integ / scan.gain, ringR, ringMean: rn ? rsum / rn : 0, peak, peakPe: peak / scan.gain, centre, contrast: centre > 0 ? peak / centre : Infinity,
      snr: varPe > 0 ? N * lsum / Math.sqrt(varPe) : 0, nMask: nm, photonsInMask: lsum, satFrac: nm ? sat / nm : 0, profile: { r: pr, v: pv } };
  }
  /* noise-free rim peak (fine sampling), ring position and centre at one focal offset — for the focus chart */
  function fineProfile(P, R, z0, cz, kind) {
    const dr = 0.025, rs = new Float64Array(Math.ceil((R + 1.6) / dr) + 1); for (let i = 0; i < rs.length; i++) rs[i] = i * dr;
    const I = kind === 'core' ? coreProfile(P, R, z0, rs, 48, 18, 12) : shellProfile(P, R, z0, rs, cz, 300, 20);
    let pk = 0, pr = 0; for (let i = 0; i < rs.length; i++) if (I[i] > pk) { pk = I[i]; pr = rs[i]; }
    let c = 0, cn = 0; for (let i = 0; i < rs.length; i++) if (rs[i] <= 0.3 * R) { c += I[i] * rs[i]; cn += rs[i]; }
    return { peak: pk, ringR: pr, centre: cn ? c / cn : 0 };
  }
  return { OBJ, PE, N_S, psf, setSaturation, widths, zeiss, excitation, absorbedPerFrame, collection, airyUm, shellProfile, coreProfile, Fshell, Fcore, Hat, hAt, render, metrics, fineProfile, materialFactor, setRayTable, pinholePass, i0e };
})();
if (typeof module !== 'undefined') module.exports = CONFOCAL;
