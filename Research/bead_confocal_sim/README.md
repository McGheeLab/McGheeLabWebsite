# PE-bead confocal assay model — simulation code

Companion to [`../PE_bead_confocal_assay_model.md`](../PE_bead_confocal_assay_model.md).

| File | What it does |
|---|---|
| `binding.py` | One-step sandwich on antibody-coated beads: mass-action ODEs for analyte A, PE-detection antibody D, solution complex AD, surface SA and SAD; finite sites and finite volume (depletion); Berg–Purcell transport factor per bead; perfect-wash dissociation phase; excess-D closed forms. |
| `optics.py` | Image formation for a fluorescent spherical shell on a point-scanning confocal: Gaussian-beam excitation times pinhole acceptance (tabulated 3-D PSF), Fibonacci-lattice shell, z-slab rendering, point-scan sampling with fast-axis smear, saturable PE emission, Poisson + PMT excess noise + offset/ADC, uniform raster bleaching dose, optional bead autofluorescence and free PE-antibody background. Metrics: integrated, ring-mean, rim peak, ring radius, SNR, LOD. |
| `run_figures.py` | Regenerates every figure in `figures/` and `figures/results.json`. `python3 run_figures.py` (all, ~5 min) or `python3 run_figures.py 3 9` (just those figures). |
| `tables.py` | Turns `results.json` into the markdown tables in `figures/tables.md`. |

Requires numpy, scipy, matplotlib (no other dependencies).

Quick start:

```python
from binding import BeadAssay
from optics import ScanSettings, BeadState, render
a = BeadAssay(k1=1e5, km1=1e-4, k2=1e5, km2=1e-3, S_T=1e6, n_beads=5000, V_uL=50)
sad, y = a.endpoint(A0=1e-10, D0=1e-9, t_inc=7200, t_wash_to_image=600)   # PE per bead at imaging
r = render(BeadState(sigma_PE_um2=sad / 201.0, z0_um=1.0), ScanSettings(objective='20x', pinhole_AU=1, px_per_bead=20, dwell_us=2, laser_uW=10))
r['image'], r['integrated'], r['snr_integrated']
```
