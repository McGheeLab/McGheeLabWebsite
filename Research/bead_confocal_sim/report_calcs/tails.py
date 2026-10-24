import sys, numpy as np
import os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from optics import ConfocalPSF, OBJ
R=4.0; c1=0.6022  # 1 nM in um^-3
lex,lem=0.561,0.575
fz={'10x':9.2,'20x':3.2,'20xD':2.8}
NA={'10x':0.45,'20x':0.75,'20xD':0.80}
def wfuns(k):
    f=fz[k]; s=f/2.3548
    psf=ConfocalPSF(OBJ[k],1.0)
    H0=psf.H[0]; zg=psf.zg; Hn=psf.H/H0
    zmax=zg[-1]; tailc=Hn[-1]*zmax**2
    def wr(z):
        z=np.abs(np.asarray(z,float))
        return np.where(z<=zmax, np.interp(z,zg,Hn), tailc/np.maximum(z,1e-9)**2)
    # geometric tail coefficient
    a=1.22*lem/NA[k]/2; th=np.arcsin(NA[k]/1.33)
    geo=a**2/np.tan(th)**2
    return {'G':lambda z: np.exp(-np.asarray(z)**2/(2*s*s)), 'L':lambda z: 1/(1+(2*np.asarray(z)/f)**2), 'W':wr}, geo, tailc
zs=np.linspace(-2000,2000,4000001)
for k in fz:
    W,geo,tailc=wfuns(k)
    print(k,'geo tail coeff a^2/tan^2 = %.3f um^2 ; repo tail coeff %.3f ; geo w(4)=%.3f'%(geo,tailc,geo/16))
    for nm,w in W.items():
        leff=np.trapezoid(w(zs),zs)
        zz=np.linspace(-R,R,8001)
        F=lambda z0: np.trapezoid(w(zz-z0),zz)
        F0=F(0); T=F0/leff
        rat=[F(z)/F0 for z in (0.5,1,2,3)]
        # 5% plateau half width
        zt=np.arange(0,4,0.01); hw=zt[np.argmax(np.array([F(z)/F0 for z in zt])<0.95)]
        Vw=np.trapezoid(np.pi*(R*R-zz**2)*w(zz),zz)
        # FWHM check
        zf=np.linspace(0,30,30001); fw=2*zf[np.argmax(w(zf)<0.5)]
        print('  %s FWHM %.2f leff %.2f w(4) %.3f T %.3f  F(.5,1,2,3)/F0 %s  pm5%% %.2f  Vw %.0f  bg/nM %.2f  dsig/nM %.2f'%(nm,fw,leff,float(w(4.0)),T,' '.join('%.3f'%r for r in rat),hw,Vw,c1*leff,c1*Vw/(2*np.pi*R*F0)))
