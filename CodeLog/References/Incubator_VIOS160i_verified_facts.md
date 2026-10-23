# Verified from the Heracell VIOS 160i / 250i LK manual (50162755 rA, Oct 2021)

The lab's own incubator. Everything below is quoted or arithmetically derived
from `Data/equipment/User Manual - Heracell - Vios 160i & 250i - 50162755rA OCT 2021.pdf`.

## Chamber

| Fact | Where |
|---|---|
| Inner 470 × 607 × 576 mm; **inner volume ≈ 165 L, useable ≈ 100 L** | §11 Specifications |
| Shelves ("inserts") 423 × 465 mm; 3 delivered, **max 11**; 10 kg each, 30 kg total | §11 |
| Temperature deviation **over time ± 0.1 °C**; **spatial ≤ ± 0.3 °C** at 37 °C (DIN 12880) | §11 |
| Auto-start to 37 °C takes **5–10 h** from 20 °C ambient | §11 |
| Heat to environment 0.06 kWh/h at 37 °C (**≈ 60 W**) | §11 |
| Ambient must be 18–34 °C; setpoint ≥ room + 3 °C | §11 |

## Humidity — the numbers the lesson had wrong

| Fact | Where |
|---|---|
| **Constant humidity at 37 °C = approx. 93 %rH** (high humidity mode) | §11, §3 Relative Humidity |
| **Low humidity mode = approx. 90 %rH** | §11 |
| "If **condensation occurs on the culture containers** due to high relative humidity, the humidity … can be set to a lower level … from approx. 93% to approx. 90%. The modification requires an extended adaption phase … must be used as a **permanent setting**." | §3 Relative Humidity |
| Reservoir max fill **3 L**, min 0.5 L; low-level alarm at 0.5 L | §11, §3 |
| Condensation on the box's *own* surfaces is prevented **actively**: "By heating the inner compartment with independent heater circuits and by **separately heating the outer door** … condensation is prevented on the sidewalls and the ceiling of the workspace and the glass door." | §3 Temperature |
| "The outer door … and the **perimeter of the door opening** are heated as well. The heat radiated onto the interior glass door prevents condensate formation." | §3 Heating System |

⇒ **The box can hold its own surfaces above the dew point. It cannot heat your
culture vessels.** A plate carried in from the cabinet is the coldest object in
the chamber, and it is the thing the Low Humidity setting exists for.

## Water quality — the lesson's "approved additive" was wrong

| Fact | Where |
|---|---|
| Sterile distilled or equivalent; **conductivity 1–20 µS/cm**, resistivity 50 kΩ·cm – 1 MΩ·cm, **pH 7–9** | §3 Water Quality |
| "Using **chlorinated tap water or additives that contain chlorine** will **void the manufacturer warranty**." | CAUTION, §3 |
| "the use of **ultrapure water** whose conductivity is out of the range … will void the manufacturer warranty" — Type 1 / 18.2 MΩ·cm "will **actively pull ions from interior components, damaging stainless steel, copper, and glass**" | CAUTION, §3 |
| If only DI is available: add sterile weak sodium bicarbonate, **84 mg/L (1 mmol/L)** | CAUTION, §3 |
| "The addition of chloride-containing disinfectants **or copper sulfate** into the water as a constant disinfectant **is not recommended**" | CAUTION, §3 |
| Cleaning ladder: mild soap in water → rinse → **diluted quaternary ammonium** → **70% alcohol** to remove disinfectant traces | CAUTION, §3 |

## Air path — the route the lesson drew does not exist on this box

| Fact | Where |
|---|---|
| **"The air stream from the water reservoir towards the workspace is channeled through a HEPA-filter in order to minimize the risk of contamination."** Separation **99.998 % at 0.3 µm** | §3 HEPA-Filter and Air Duct |
| The airbox rests on the water-reservoir cover panel and is **pushed against the air intake**; its tube slides into the **fan outlet** | §3, §4 |
| "The air duct feeds the flow of air **from the fan along the rear wall to the workspace ceiling**, thus ensuring an optimum temperature distribution" and intermixing the incoming process gases | §3 |
| Fan wheel and all sensors (T, CO₂, O₂, rH) are **mounted in the rear wall** | §3 Sensor System |
| A **pre-filter** (dual-layer wire mesh, silicone frame, autoclavable) sits on the front of the reservoir cover; removed to refill, **stays in for Steri-Run** | §3 Prefilter |
| A **pressure compensation opening** in the rear wall vents to the room | §3, §2 |

⇒ Circuit: **reservoir → airbox → HEPA → rear-wall duct → ceiling → down through
the workspace → back to the reservoir.** The textbook "the fan blows spores off
the water onto your cultures" route is *filtered on this machine*. What is **not**
filtered is anything that enters the workspace downstream of the filter — what
you carry in, and what you spill on a shelf.

## Doors

| Fact | Where |
|---|---|
| Two doors: heated solid **outer door**, tempered-glass **inner door** (or optional gas-tight screen) | §3 |
| The door switch is at the upper edge of the workspace opening and is tripped by the **glass** door: **gas supply and workspace heating are suspended** | §3 Door Switch |
| **Alarm if the door is open longer than 30 s.** At **10 min**, audible alarm + alarm relay | §3 Door Switch |
| "The outer door can only be closed **after the glass door has been latched** properly." | §3 |
| **Hinges are field-reversible on both the outer door and the glass door** (listed accessory: "door hinge replacement on outer door and glass door") | §1 Accessories |
| On devices with a gas-tight screen, the door-switch function is tripped by the **outer** door instead | §3 Note |

## The OEM answer to "a box for each experiment"

| Fact | Where |
|---|---|
| Optional **gas-tight screen** (3-fold on the 160i, 6-fold on the 250i): "Due to the significantly smaller cross-section of the openings … a **considerably lower contamination hazard** and the **recovery times … are shorter** for workspace temperature, CO₂, O₂ and relative humidity." | §3 Glass Door |
| **Cell Locker**: "consists of a **polycarbonate chamber with two membrane filters, which are permeable to water vapor and gas, but are impermeable to microorganisms**." | Appendix, Cell Locker §3.1 |
| Cell Locker: 185 × 156 × 380 mm, **inner volume ≈ 5.4 L**, 1.8 kg, 5 kg per tray | Cell Locker §8 |
| Cell Locker: **autoclave max 121 °C / 15 min**, fast exhaust, **max 12 autoclave cycles**; door seal checked every 6 months; membrane filter and cover gasket are wear parts | Cell Locker §1.5, §5, §8 |
| Cell Locker must be **removed before a Steri-Run** (max operating temperature) | §8 CAUTION |
| Introducing a **powered** accessory shifts the whole control range and causes condensation: 0 W → RT+3 °C, 5 W → RT+6.5 °C, "condensation (e.g. at the glass door) may occur" | §3 Note, Operating conditions |

⇒ The commercial answer to Alex's aluminium box is a **sealed box vented through a
0.2 µm-class membrane** — gas and vapour pass, organisms do not. It is the vented
flask cap of Lesson 2 §3.1, at box scale, and it dissolves the lid-gap trade-off
that a plain lid cannot escape.

## Derived on the manual's own numbers

- Dew point at 37 °C (Magnus): 93% → 35.68 °C (**margin 1.32 °C**); 90% → 35.08
  (1.92); 95% → 36.06 (0.94); 98% → 36.63 (0.37). The box's own spatial spread is
  ≤ ±0.3 °C, so its surfaces clear the margin at 93% — **your vessels do not**.
- τ = ρ c t / h for a metal box: the **area cancels**, so the thermal buffering of
  a box depends on **wall thickness alone** — 5 mm aluminium → 20 min at h = 10 W/m²K.
- τ_gas = V L /(D P g) through a lid gap: 5.4 L box, 5 mm land, 1.04 m perimeter —
  0.3 mm gap → 88 min for CO₂; 1 mm → 26 min; 3 mm → 9 min. Water vapour is
  D-scaled: always **1.6× faster than CO₂**, so a box always re-humidifies before
  it re-gasses.
