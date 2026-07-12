# Discussion Points

## Mario Romero-Ortega — Bionic Control of Robotic Limbs

- What are the best methods to control them?
  - Surface EMG is non-invasive but noisy — when is it "good enough," and when do you need to go inside the body?
  - Compare targeted muscle reinnervation, intrafascicular arrays, and regenerative peripheral neural interfaces — which trade-off (invasiveness, signal fidelity, longevity) matters most for a hand vs. a leg?
  - If axons grow *through* the electrode, what new failure modes appear that a metal cuff electrode would never have?
- What is the main difference between prosthetic and bionic limbs?
  - A prosthetic restores form; a bionic limb is bidirectionally coupled — why does giving the user back *touch and proprioception* change what they can do, not just how it feels?
  - Is "bionic" a property of the device, the surgery, or the user's brain learning to use it?
  - Where would you draw the line between "very advanced prosthetic" and "bionic" — and does the line even matter clinically?
- How are upper and lower robotic limbs engineered?
  - Upper limbs prioritize dexterity and sensation; lower limbs prioritize dynamics and load-bearing — what does that mean for the *control bandwidth* each one needs?
  - A missed signal in a hand drops a coffee cup; a missed signal in a leg drops the user — how should that asymmetry shape safety design?
  - What does "gait" demand that "grasp" doesn't, and vice versa?

---

## Nan-kuei Chen — Biomedical Imaging: From Physics to Clinical Impact

- How can technologies like low-field MRI and AI help make advanced medical imaging more accessible to people around the world?
  - A 3T MRI scanner costs more than most rural hospitals' annual budget — what does a low-field system give up to become deployable, and is that trade worth it?
  - If AI can clean up a noisier low-field image to "look like" a high-field one, are we imaging the patient or imaging the model's expectations?
  - Cloud-based interpretation moves the radiologist off-site — what new problems (privacy, bandwidth, liability) does that create?
- What does brain imaging (like fMRI) teach us about how the brain works, and how might this change how we treat diseases or injuries?
  - fMRI shows *where* activity happens but not *what* the brain is computing — what kinds of clinical decisions can we make from "where" alone?
  - Brain plasticity means the map changes after injury — should rehabilitation be guided by imaging, or does that risk over-fitting to a single scan?
  - When two patients have the same diagnosis but different fMRI patterns, which one do you trust?
- If you were an engineer, what problem in healthcare would you try to solve using imaging or technology, and why?
  - Pick a disease whose *outcome* would change if you could see it 5 years earlier — what would you build?
  - Is the bigger gap in *new* imaging tech or in *deploying* what we already have?
  - What problem is too unglamorous to attract funding but would help the most people?

---

## Philipp Gutruf — Next-Gen Wearables for Diagnostics and Therapeutics

- What has changed that allows us to now enable automated diagnosis?
  - Soft conformal materials, wireless power, on-device ML, continuous longitudinal data — which of these was the *bottleneck* until recently?
  - A consumer fitness tracker and a clinical-grade wearable record similar signals — what separates "wellness" data from a diagnosis a doctor can act on?
  - Continuous data also means continuous false alarms — how do you design a wearable that doesn't cry wolf?
- What is important for people to keep using wearables?
  - Imperceptibility is the deciding factor — what does a device need to *stop being* for the user to forget it's there?
  - Battery anxiety, charging rituals, skin irritation — rank the adherence killers; which one is engineering's job and which is psychology's?
  - Would you trade signal quality for invisibility? Where's the limit?
- What biosignal can be used to track fracture recovery?
  - Osseosurface electronics read strain and mechanical loading directly off bone — why is that a better recovery signal than an X-ray taken once a month?
  - An X-ray is a snapshot; bone strain is a movie — what clinical decisions become possible when you have the movie?
  - If a surgeon sees daily loading data, do they intervene more or less? Could continuous monitoring create *over*-treatment?

---

## Dongkyun "DK" Kang — In Vivo Microscopy and Low-Cost Diagnostics

- What is the standard medical procedure to make the final diagnosis?
  - Biopsy → fixation → sectioning → pathologist — list every place this pipeline can fail, and which failure costs the patient the most.
  - Sampling error: the pathologist only sees the slice you cut — how often does the disease hide in the slice you didn't?
  - The pipeline takes days; some patients live hours away from any lab — what does "diagnostic delay" actually cost in lives?
- What is in vivo microscopy?
  - Confocal, multiphoton, light-sheet — all replace *physical* sectioning with *optical* sectioning. Why is that a step-change, not an incremental improvement?
  - Imaging living tissue over time means you can watch a tumor respond — what new questions does that unlock?
  - What does in vivo microscopy give up vs. classical histology — and is the trade-off worth it at point-of-care?
- How can you make in vivo microscopy tools at low cost?
  - A smartphone + slit aperture + diffraction grating = confocal microscopy without beam-scanning hardware — what made the smartphone the right platform now and not 10 years ago?
  - The Uganda Kaposi's sarcoma program is the proof-of-concept — what changes when the same device targets cervical, oral, and skin cancer screening?
  - Cheap hardware still needs a trained operator — is the bottleneck the device or the workforce around it?

---

## Frederic Zenhausern — Convergence of Engineering in Medicine

- How is medical research conducted in the USA, and what are the 3 main sources of funding to support biomedical research in the USA?
  - Federal agencies (NIH, NSF, DoD/DARPA), foundations and philanthropy, and industry/VC — what kind of project does each one fund, and which one would *your* idea fit?
  - DARPA funds risky bets; NIH funds incremental science — does that division of labor still make sense, or does it leave gaps?
  - Industry funding gets products to patients but also shapes what gets studied — what gets *unstudied* as a result?
- What are the 3 research priorities to address critical needs in the next 5–10 years?
  - Precision/predictive diagnostics, personalized therapeutics, AI-augmented decision support in low-resource settings — which one closes the biggest healthcare gap and which is the most over-hyped?
  - "Personalized" medicine works best for patients with rich data; what happens to populations that aren't in the training set?
  - If you had to drop one of the three, which one survives without it?
- What is the translational process for transferring discoveries to clinical practices?
  - Discovery → preclinical → regulatory → clinical trials → commercialization — at which step do *most* good ideas die, and why?
  - The "valley of death" between a published paper and a deployable product — what's actually in that valley?
  - Convergence (engineering + nano + molecular medicine) is the pitch — but does combining fields speed translation or slow it down by adding more regulators?

---

## Jennifer Barton — Optical Imaging for Early Detection of Ovarian Cancer

- For what biomedical applications are optical imaging techniques well suited? What are their limitations?
  - Optics excels at surface and near-surface tissue, high resolution, and miniaturization — what does that rule *out*, and is that ruled-out space where ovarian cancer hides?
  - Light doesn't penetrate deep tissue — when is that a limit and when is it actually a feature (e.g., specificity, no radiation)?
  - Compare optical imaging to MRI/CT for early detection — what does each one see that the others miss?
- What advances have made fallopian tube imaging possible, where it was not 10 years ago?
  - Miniaturized endoscopes, better light sources, fiber optics, micro-optics — which advance was the *unlock*?
  - Anatomically, the fallopian tube is narrow, curved, and delicate — what engineering constraints does that put on every component?
  - Why did imaging the ovary itself fail, and why is the *fallopian tube* now the right target?
- What are the hurdles to bringing a new technology like the falloposcope into standard of care for ovarian cancer detection?
  - Would *you* choose prophylactic surgery to avoid a 15% lifetime risk? If a falloposcope existed, would your answer change — and what level of certainty would you need?
  - FDA approval, OB/GYN training, insurance reimbursement, patient acceptance — rank these hurdles; which one kills the most good devices?
  - A screening test only saves lives if people get screened — what's the path from "exists" to "routine"?

---

## Jerome Lacombe — Modeling the Tumor Microenvironment

- What is the tumor microenvironment, and how do biochemical signals and mechanical forces within it influence cancer development and response to therapy?
  - Stromal cells, immune cells, ECM stiffness, hypoxia, pH — which of these does a flat 2D culture *fail* to reproduce, and which one matters most for drug response?
  - A drug that works in a dish but fails in a patient — how often is the TME the reason?
  - Mechanical forces (stiffness, shear, compression) actually change gene expression — does that mean a "tumor" growing on plastic is even the same disease?
- What are the main challenges scientists face when trying to recreate the tumor microenvironment in the lab?
  - Cellular diversity, spatial organization, vascularization, immune components, patient-to-patient variability — which one is the showstopper?
  - If you can only include *three* TME features in your model, which three give you the most predictive power?
  - How do you validate that your "tumor-on-chip" is actually behaving like a tumor and not just a complicated cell culture?
- How do bioengineered systems technically recreate aspects of the tumor microenvironment, and what specific advantages do these approaches provide?
  - Organoids vs. organ-on-chip vs. bioprinted tissue — what does each format do well, and where does each one break?
  - These models are slower and more expensive than 2D — when is the extra realism worth the cost?
  - Could a sufficiently accurate tumor-on-chip *replace* animal models, and what would have to be true for the FDA to accept that?

---

## Elizabeth Hutchinson — Brain MRI for Neurodegenerative Disorders

- How could different types of diagnostics (e.g. clinical exam, blood markers, imaging) be used together to best serve patients?
  - Cognitive tests are cheap but late; blood markers are emerging but noisy; MRI is expensive but anatomical — how would you stage them?
  - Two diagnostics that *agree* aren't twice as confident if they share the same confounder — how do you pick *complementary* tests?
  - Designing for the patient pathway vs. the research study — what's the difference?
- If we had the ability to use diffusion MRI to accurately report any shape or size feature of cellular structures, what would be important or interesting to target in neurodegenerative diseases?
  - Cell density, axon diameter, myelin thickness, edema, soma size — which one would tell you Alzheimer's is starting *before* symptoms?
  - Diffusion MRI measures water motion as a *probe* of tissue structure — what's the limit of that inference?
  - White matter tract connections degrade before cell death — is "tract integrity" the right early biomarker, or is it already too late?
- What are the ethics of performing diagnostics when there is no effective prevention, treatment or cure?
  - Would *you* want to know you have AD pathology 10 years before symptoms? What would you do with that information?
  - Does early diagnosis without a treatment harm patients (insurance, mental health, autonomy) more than it helps?
  - Research needs early-stage patients; patients need useful answers — can a diagnosis "for science" be ethical?

---

## Alexander McGhee — 3D In Vitro Models of Cancer via Cellular Assembly and Bioprinting

- Why are in vitro models a useful resource? Imagining the future of these models, what can we do with them?
  - Animals are slow and ethically loaded; trials are slow and risky — what specifically does an in vitro model give you that those two can't?
  - Imagine every patient's tumor reconstructed in a dish before therapy is given — what changes about oncology if that becomes routine?
  - What's the highest-value question an in vitro model can answer *that no other system can*?
- What are the fundamental problems with the way we develop targeted therapeutics for cancer?
  - Most drugs are screened against 2D monolayers — which features of a real tumor (architecture, stroma, mechanics) do those screens systematically miss?
  - A drug that works on every cell in a flat dish often fails in the body — is the dish the problem, or the drug?
  - If we screened on 3D models from the start, would we have *fewer* approved drugs or *better* ones?
- What are the issues in 3D bioprinting, and how does harnessing the power of cellular collective behavior help solve these issues?
  - Resolution limits, cell viability, recapitulating native heterogeneity — which one is the hardest physics problem and which is the hardest biology problem?
  - Cells *self-organize* — at what point do you stop printing and let the biology finish the job?
  - If collective behavior builds the tissue, what does the printer's job become — scaffold, seed, or trigger?

---

## Monique Martinez

- TBD
