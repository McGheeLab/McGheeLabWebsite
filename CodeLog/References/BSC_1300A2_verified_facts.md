# Verified from the Thermo 1300 Series A2 manual (7021355-EN Rev 20)

| Fact | Where |
|---|---|
| Inflow 0.53 m/s (105 ft/min); downflow 0.32 m/s (63 ft/min) | spec table |
| 4 ft @ 8": downflow 829 m³/h, exhaust 468, total 1298 | spec table |
| 4 ft @ 10": downflow 829 m³/h, exhaust 585, total 1415 | spec table |
| 6 ft @ 8": exhaust 702; @10": 878 | spec table |
| Work position = 8" or 10" opening, **+0.25" / −0.75"** | Use of the Window |
| Physical **dimple** on the frame; GREEN sash-height LED, RED if moved | Figs 1-5/1-6 |
| **Raise the window 1" above work position → window alarm activates** | §8 Sash Alarms |
| Sensors report work position / closed / **"unsafe intermediate position"** | Window position monitoring |
| Room air in at the opening → **negative-pressure drain-pan air duct** → plenum in the top | HEPA Filters |
| **Paper catch grids beneath the work tray**, in the air duct **between the inner and outer back wall** | Paper Catch Grids |
| Room air is **mixed with recirculating HEPA-filtered air**, filtered proportionally by the downflow and exhaust filters | HEPA Filters |
| Work tray has **ventilation slots** — "do not block air circulation at the ventilation slots" | Working Recommendations |
| "Do not cause air turbulence by quick hand, arm or body movements **in the sample chamber** or in front of the work opening" | Working Recommendations |
| Smoke: "No smoke shall billow over the solid work surface or penetrate onto it" | §8 smoke pattern |
| Downflow smoke 4" above the opening: "smooth downward flow with **no dead spots or upward flow**" | §8 |
| Armrests "minimize blockage of airflow at the front grille" | §1 |
| SmartFlow = "automatic airflow compensation ... adjusts motor speed as filters load"; indicator shows "capacity in reserve" | §1 |
| DAVe monitors inflow AND downflow independently, alarms outside band | §1 |

## Derived by arithmetic ON the manual's own numbers (all checkable)

- Inflow volume must equal exhaust volume (the only two openings to the room).
- 4 ft @ 8": 468 m³/h = 0.130 m³/s. At 0.53 m/s the opening area is 0.245 m² → width 1.21 m ✓ (a 4-foot cabinet)
- 4 ft @ 10": 585 m³/h = 0.1625 m³/s over 1.21 × 0.254 m = 0.3066 m² → **0.530 m/s** ✓
- 6 ft: 878/702 = 1.2507 ≈ 10/8 = 1.25 ✓
- ⇒ **The cabinet holds 0.53 m/s at BOTH certified openings by raising the exhaust
  volume in proportion to the height. Downflow volume is unchanged (829 both).**
- Recirculated fraction = 829/1297 = **64%** @ 8", 829/1415 = **59%** @ 10".
  (The "~70%" everyone quotes is a rule of thumb, not this cabinet.)

## Consequence for the lesson

The shipped §2.1 teaches fixed-Q: v_in = Q/(w·h), so raising the sash lowers the
velocity. **That is right for an old fixed-speed cabinet with a manual damper and
WRONG for this one.** eq. 1.2.2 still holds — it is a definition — but which term
the cabinet holds constant is a property of the cabinet. This one holds *v* and
varies *Q*, until the reserve runs out.

Which makes the real answer to "why is the manufacturer so strict about the mark"
much better than the shipped one: **the position alarm fires while the airflow is
still perfectly in specification.** What you lose off the mark is not velocity, it
is *certification* — NSF/ANSI 49 inflow, downflow, smoke-pattern and containment
tests are all performed at the marked opening, and nothing has been verified
anywhere else. The compensation reserve exists for filter loading, not for you.
