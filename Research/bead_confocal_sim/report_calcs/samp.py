import numpy as np
lex=0.561;R=4.0
dx=0.01; L=14; x=np.arange(-L/2,L/2,dx); X,Y=np.meshgrid(x,x); RHO=np.hypot(X,Y)
def analytic_img(NA,fz):
    sz=fz/2.3548; w=lambda z: np.exp(-z*z/(2*sz*sz))
    sxy=0.51*lex/NA/2.3548
    # 1D radial semi-analytic: integrate over shell surface with 2D gaussian via ring decomposition -> use fine sampling of shell points
    I=np.zeros_like(RHO); 
    # sample shell surface by area-uniform points (Archimedes: z uniform)
    n=400000; rng=np.random.default_rng(0); z=rng.uniform(-R,R,n); ph=rng.uniform(0,2*np.pi,n)
    r=np.sqrt(R*R-z*z); px=r*np.cos(ph); py=r*np.sin(ph); wt=w(z)*(4*np.pi*R*R/n)
    H,_,_=np.histogram2d(py,px,bins=[np.append(x,x[-1]+dx)-dx/2]*2,weights=wt)
    H/=dx*dx
    k=np.fft.fftfreq(len(x),dx); KX,KY=np.meshgrid(k,k)
    G=np.exp(-2*np.pi**2*sxy*sxy*(KX**2+KY**2))
    return np.real(np.fft.ifft2(np.fft.fft2(H)*G))
def bil(B,xs,ys):
    fx=(xs+L/2)/dx; fy=(ys+L/2)/dx
    i0=np.floor(fx).astype(int); j0=np.floor(fy).astype(int); ax=fx-i0; ay=fy-j0
    return ((1-ax)*(1-ay)*B[j0,i0]+ax*(1-ay)*B[j0,i0+1]+(1-ax)*ay*B[j0+1,i0]+ax*ay*B[j0+1,i0+1])
rng=np.random.default_rng(1)
for name,NA,fz in (('10x/0.45',0.45,9.17),('20x/0.80',0.80,2.80),('20x/0.75',0.75,3.21)):
    B=analytic_img(NA,fz); true_pk=B.max(); true_F=B.sum()*dx*dx
    print(name,'true peak',round(true_pk,2),'F',round(true_F,2))
    for N in (4,6,8,12,16,25,40,60):
        p=2*R/N; m=max(1,int(round(p/dx)))
        Bs=np.apply_along_axis(lambda r: np.convolve(r,np.ones(m)/m,mode='same'),1,B)
        pk=[];F=[]
        for t in range(300):
            ox,oy=rng.uniform(0,p,2)
            g=np.arange(-5.6,5.6,p); xs,ys=np.meshgrid(g+ox,g+oy)
            v=bil(Bs,xs,ys); pk.append(v.max()/true_pk); F.append(v.sum()*p*p/true_F)
        pk=np.array(pk);F=np.array(F)
        print(f"  N={N:3d} px={p:.3f}  peak mean {pk.mean():.3f} sd {pk.std():.3f}  F mean {F.mean():.4f} cv {F.std()/F.mean()*100:.2f}%")
