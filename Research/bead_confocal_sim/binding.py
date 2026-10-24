"""One-step sandwich immunoassay on antibody-coated beads.

Species
    A    free analyte                      (M)
    D    free PE-labelled detection Ab     (M)
    AD   solution complex analyte:detection(M)
    SA   analyte on a capture site         (molecules per bead)
    SAD  full sandwich on a capture site   (molecules per bead)  <-- the only observable (PE on the surface)
    S    free capture sites = S_T - SA - SAD

Reactions (mass action, Langmuir: one analyte per site)
    A  + S  <-> SA    k1,  km1     analyte onto the capture antibody
    D  + SA <-> SAD   k2,  km2     detection Ab onto captured analyte
    AD + S  <-> SAD   k3,  km3     pre-formed complex onto the capture antibody
    A  + D  <-> AD    k4,  km4     pre-complex formation in solution
Defaults take k3 = k1, km3 = km1 (the capture bond does not care whether D is attached) and
k4 = k2, km4 = km2 (the detection bond does not care whether the analyte is captured).  That makes the
thermodynamic cycle consistent (K1*K2 = K3*K4).  Override any of them to model sterics/avidity.

Transport: each surface reaction is multiplied by a Berg-Purcell / partial-absorber factor
    f = kD / (kD + kon * sites)   with  kD = 4*pi*D_coef*R*N_A   (diffusion-limited rate per bead, M^-1 s^-1)
which slows both binding and unbinding (rebinding) without moving the equilibrium. Free analyte diffuses with D_A,
the detection antibody with D_D and the analyte:antibody complex with D_AD (None = D_D, as revision 1 had it).
Because of rebinding, the post-wash decay runs at f2*km2 + f3*km3, a little slower than km2 + km3.

Defaults are the report's reference case (params.BINDING; report A.2.4).

Depletion: the finite sample volume and bead number are tracked through c_b = N_beads / (N_A * V), the
concentration (M) equivalent of one molecule per bead.
"""
import numpy as np
from scipy.integrate import solve_ivp
from params import BINDING as _B

N_AVO = 6.02214076e23


class BeadAssay:
    def __init__(self, k1=_B['k1'], km1=_B['km1'], k2=_B['k2'], km2=_B['km2'], k3=None, km3=None, k4=None, km4=None,
                 S_T=_B['S_T'], R_um=_B['R_um'], n_beads=_B['n_beads'], V_uL=_B['V_uL'],
                 D_A=_B['D_A'], D_D=_B['D_D'], D_AD=_B['D_AD'], transport=True):
        self.k1, self.km1, self.k2, self.km2 = k1, km1, k2, km2
        self.k3 = k1 if k3 is None else k3
        self.km3 = km1 if km3 is None else km3
        self.k4 = k2 if k4 is None else k4
        self.km4 = km2 if km4 is None else km4
        self.S_T, self.R_um, self.n_beads, self.V_uL = S_T, R_um, n_beads, V_uL
        self.D_A, self.D_D, self.transport = D_A, D_D, transport
        self.D_AD = D_D if D_AD is None else D_AD

    # ---- derived quantities -------------------------------------------------
    @property
    def c_b(self):
        """M per (molecule per bead)."""
        return self.n_beads / (N_AVO * self.V_uL * 1e-6)

    @property
    def capacity_M(self):
        """Total capture capacity of all beads expressed as a concentration (M)."""
        return self.S_T * self.c_b

    def kD(self, D_coef):
        """Smoluchowski diffusion-limited rate constant per bead, M^-1 s^-1 (4 pi D R N_A)."""
        return 4 * np.pi * D_coef * (self.R_um * 1e-6) * 1e3 * N_AVO

    @property
    def KD1(self):
        return self.km1 / self.k1

    @property
    def KD2(self):
        return self.km2 / self.k2

    def damkohler(self):
        """Da = intrinsic on-rate of an empty bead / diffusion-limited rate, for A and for D(AD)."""
        return self.k1 * self.S_T / self.kD(self.D_A), self.k2 * self.S_T / self.kD(self.D_D)

    def area_um2(self):
        return 4 * np.pi * self.R_um ** 2

    # ---- right-hand side ----------------------------------------------------
    def rhs(self, t, y, wash):
        A, D, AD, SA, SAD = y
        S = self.S_T - SA - SAD
        if self.transport:
            f1 = self.kD(self.D_A) / (self.kD(self.D_A) + self.k1 * S)
            f2 = self.kD(self.D_D) / (self.kD(self.D_D) + self.k2 * SA)
            f3 = self.kD(self.D_AD) / (self.kD(self.D_AD) + self.k3 * S)
        else:
            f1 = f2 = f3 = 1.0
        r1 = f1 * (self.k1 * A * S - self.km1 * SA)        # molecules/bead/s
        r2 = f2 * (self.k2 * D * SA - self.km2 * SAD)
        r3 = f3 * (self.k3 * AD * S - self.km3 * SAD)
        r4 = self.k4 * A * D - self.km4 * AD                # M/s
        if wash:
            # perfect sink: released molecules are carried away, nothing rebinds
            return [0.0, 0.0, 0.0,
                    -f1 * self.km1 * SA + f2 * self.km2 * SAD,
                    -f2 * self.km2 * SAD - f3 * self.km3 * SAD]
        cb = self.c_b
        return [-cb * r1 - r4,
                -cb * r2 - r4,
                r4 - cb * r3,
                r1 - r2,
                r2 + r3]

    def _solve(self, y0, t_end, wash, t_eval=None):
        sol = solve_ivp(self.rhs, (0.0, t_end), y0, args=(wash,), method='LSODA',
                        rtol=1e-8, atol=[1e-20, 1e-20, 1e-20, 1e-6, 1e-6], t_eval=t_eval, dense_output=True)
        return sol

    # ---- experiments --------------------------------------------------------
    def incubate(self, A0, D0, t_inc, t_eval=None):
        """One-step incubation: analyte A0 (M) and detection Ab D0 (M) added together to empty beads."""
        return self._solve([A0, D0, 0.0, 0.0, 0.0], t_inc, wash=False, t_eval=t_eval)

    def wash(self, y_end, t_obs, t_eval=None):
        """Perfect wash then observation: solution species removed; SAD decays by km2 (loses D) and km3 (loses AD)."""
        y0 = [0.0, 0.0, 0.0, y_end[3], y_end[4]]
        return self._solve(y0, t_obs, wash=True, t_eval=t_eval)

    def endpoint(self, A0, D0, t_inc, t_wash_to_image=0.0):
        """PE molecules per bead at imaging time."""
        inc = self.incubate(A0, D0, t_inc)
        y = inc.y[:, -1]
        if t_wash_to_image > 0:
            w = self.wash(y, t_wash_to_image)
            y = w.y[:, -1]
        return y[4], y

    def curve(self, A_list, D0, t_inc, t_wash_to_image=0.0):
        return np.array([self.endpoint(A, D0, t_inc, t_wash_to_image)[0] for A in A_list])

    # ---- closed forms (no depletion, D in excess, equilibrium) --------------
    def sad_eq_excessD(self, A, D0):
        """Equilibrium SAD per bead with free A = A and free D = D0 (no depletion)."""
        KD1, KD2 = self.KD1, self.KD2
        return self.S_T * A * D0 / (KD1 * KD2 + KD2 * A + A * D0)

    def apparent_KD(self, D0):
        """Apparent Langmuir constant of the PE-coverage isotherm in the excess-D limit."""
        return self.KD1 * self.KD2 / (self.KD2 + D0)

    def sad_max_excessD(self, D0):
        return self.S_T * D0 / (self.KD2 + D0)


def pe_density(sad_per_bead, R_um=4.0):
    """PE molecules per um^2 of bead surface."""
    return sad_per_bead / (4 * np.pi * R_um ** 2)


if __name__ == '__main__':
    a = BeadAssay()
    print('c_b (M per molecule/bead) = %.3g   capacity = %.3g M (%.0f pM)' % (a.c_b, a.capacity_M, a.capacity_M * 1e12))
    print('kD(A) = %.3g  kD(D) = %.3g M^-1 s^-1 per bead;  Da_A = %.2f  Da_D = %.2f' % (a.kD(a.D_A), a.kD(a.D_D), *a.damkohler()))
    for A in [1e-12, 1e-11, 1e-10, 1e-9, 1e-8]:
        sad, y = a.endpoint(A, 1e-9, 7200)
        print('A0=%7.1e M  SAD=%9.1f /bead  (%.1f PE/um2)  excess-D eq=%9.1f' % (A, sad, pe_density(sad), a.sad_eq_excessD(A, 1e-9)))
