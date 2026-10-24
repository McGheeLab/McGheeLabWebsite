import numpy as np
h=6.626e-34;c=2.998e8;R=4.0
eps561=1.9e6; sig=3.82e-21*eps561; tau=2.7e-9; Q=0.82; phid=1.1e-5
Isat=1/(sig*tau); print('sigma_abs cm2',sig,'Isat',Isat)
phi1=1e-6/(h*c/561e-9); print('photons/s per uW',phi1)
for name,NA,fwl,fz in (('10x/0.45',0.45,0.636,9.17),('20x/0.75',0.75,0.381,3.21),('20x/0.80',0.80,0.358,2.80)):
    A=np.pi*fwl**2/(4*np.log(2))*1e-8
    I0=phi1/A; Psat=Isat/I0
    th=np.arcsin(NA/1.33); coll=(1-np.cos(th))/2
    eta=coll*0.85*0.55*0.8*0.42*0.8
    sz=fz/2.3548; z=np.linspace(-40,40,80001); w=np.exp(-z*z/(2*sz*sz)); leff=np.trapezoid(w,z)
    t=np.linspace(-R,R,8001); wt=np.exp(-t*t/(2*sz*sz))
    F=2*np.pi*R*np.trapezoid(wt,t); Vw=np.trapezoid(np.pi*(R*R-t*t)*wt,t)
    sheet=sig*1e8*phi1*1e-6*Q*eta  # detected per (PE/um2)(uW)(us), in-focus flat sheet
    ratio=eta*Q*F/(4*np.pi*R*R)
    print(f"{name}: A_eff={A*1e8:.3f}um2 I0/uW={I0:.2e} P(k=1)={Psat:.0f}uW P(k=0.1)={0.1*Psat:.1f}uW coll={coll:.4f} eta={eta:.4f} sheet_det/(PE/um2.uW.us)={sheet:.4f} leff={leff:.2f} F={F:.1f}um2 Vw={Vw:.1f}um3 det/abs={ratio:.4f} det-per-PE-before-bleach={ratio/phid:.0f} bgEq(1nM)={0.602*leff:.2f}PE/um2 exclBias(1nM)={0.602*Vw/F:.2f}PE/um2")
# dose per frame
for name,P,tau_d,px in (('10x',5,2,0.32),('20x',2,2,0.2),('20x',2,2,0.5),('10x',5,2,0.5)):
    D=sig*phi1*P*tau_d*1e-6/(px*px*1e-8)
    print(name,P,'uW',tau_d,'us px',px,'absorptions/frame',round(D,1),'bleach frac/frame %.4f'%(phid*D))
