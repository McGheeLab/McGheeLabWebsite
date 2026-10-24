import numpy as np
R=4.0; lex=0.561
fz={'10x':9.2,'20x':3.2,'20xD':2.8}; NA={'10x':0.45,'20x':0.75,'20xD':0.80}
dx=0.01; L=10.24; n=int(L/dx)
k=np.fft.fftfreq(n,dx); KX,KY=np.meshgrid(k,k)
rng=np.random.default_rng(1); N=8_000_000
z=rng.uniform(-R,R,N); ph=rng.uniform(0,2*np.pi,N); rr=np.sqrt(R*R-z*z)
xs=rr*np.cos(ph); ys=rr*np.sin(ph)
ix=((xs+L/2)/dx).astype(int); iy=((ys+L/2)/dx).astype(int)
wt_area=4*np.pi*R*R/N/dx/dx
def img(w):
    H=np.zeros((n,n)); np.add.at(H,(iy,ix),w*wt_area); return H
for kk in fz:
    f=fz[kk]; s=f/2.3548; sxy=0.51*lex/NA[kk]/2.3548
    G=np.exp(-2*np.pi**2*sxy*sxy*(KX**2+KY**2))
    for nm,wf in (('G',lambda z: np.exp(-z*z/(2*s*s))),('L',lambda z: 1/(1+(2*z/f)**2))):
        pk=[]
        for z0 in (0,0.5,1,2,3):
            B=np.real(np.fft.ifft2(np.fft.fft2(img(wf(z-z0)))*G))
            # azimuthal average radial profile max
            Y,X=np.indices(B.shape); r=np.hypot((X+0.5)*dx-L/2,(Y+0.5)*dx-L/2)
            b=(r/0.02).astype(int); prof=np.bincount(b.ravel(),B.ravel())/np.maximum(np.bincount(b.ravel()),1)
            pk.append(prof.max())
        print(kk,nm,'peak',' '.join('%.2f'%p for p in pk),' drop',' '.join('%.0f%%'%(100*(1-p/pk[0])) for p in pk[1:]),flush=True)
