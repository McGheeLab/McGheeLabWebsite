import sys, numpy as np
import os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from optics import render, BeadState, ScanSettings
R=4.0; lex=0.561
fz={'10x':9.2,'20x':3.2,'20xD':2.8}; NA={'10x':0.45,'20x':0.75,'20xD':0.80}
dx=0.02; L=24; x=np.arange(-L/2,L/2,dx); X,Y=np.meshgrid(x,x); RHO=np.hypot(X,Y)
k=np.fft.fftfreq(len(x),dx); KX,KY=np.meshgrid(k,k)
def proj(z0,w):
    I=np.zeros_like(RHO); m=RHO<R-1e-9
    zz=np.sqrt(R*R-RHO[m]**2); I[m]=R/zz*(w(zz-z0)+w(-zz-z0)); return I
for kk in fz:
    f=fz[kk]; s=f/2.3548; sxy=0.51*lex/NA[kk]/2.3548
    G=np.exp(-2*np.pi**2*sxy*sxy*(KX**2+KY**2))
    for nm,w in (('G',lambda z: np.exp(-z*z/(2*s*s))),('L',lambda z: 1/(1+(2*z/f)**2))):
        pk=[]
        for z0 in (0,0.5,1,2,3):
            B=np.real(np.fft.ifft2(np.fft.fft2(proj(z0,w))*G)); row=B[len(x)//2]; pk.append(row.max())
        print(kk,nm,'peak',' '.join('%.2f'%p for p in pk),' drop',' '.join('%.0f%%'%(100*(1-p/pk[0])) for p in pk[1:]))
    sc=ScanSettings(objective=kk,pinhole_AU=1,px_per_bead=40,laser_uW=1)
    pk=[];F=[]
    for z0 in (0,0.5,1,2,3):
        r=render(BeadState(z0_um=z0,sigma_PE_um2=1000),sc,fov_px=64,noise=False,n_points=120000)
        pk.append(r['peak']); F.append(r['integrated'])
    print(kk,'W(repo) peak drop',' '.join('%.0f%%'%(100*(1-p/pk[0])) for p in pk[1:]),' F',' '.join('%.3f'%(q/F[0]) for q in F[1:]))
