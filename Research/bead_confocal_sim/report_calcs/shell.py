import numpy as np
lex,lem=0.561,0.575; lbar=np.sqrt(2)*lex*lem/np.sqrt(lex**2+lem**2)
objs={'10x/0.45':(10,0.45),'20x/0.75':(20,0.75),'20x/0.80':(20,0.80)}
R=4.0
def secz(NA,AU,n):
    PH=AU*1.22*lem/NA
    t1=0.88*lem/(n-np.sqrt(n*n-NA*NA)); t2=np.sqrt(2)*n*PH/NA
    return PH,t1,t2,np.sqrt(t1*t1+t2*t2)
print("lbar",lbar)
for k,(M,NA) in objs.items():
    for AU in (0.25,1,2,4):
        PH,t1,t2,f1=secz(NA,AU,1.0); _,a,b,fw=secz(NA,AU,1.33)
        wo=0.64*lbar/(1.33-np.sqrt(1.33**2-NA**2))
        print(k,AU,"PH_obj %.2f"%PH,"FWHMz n1 %.2f water %.2f"%(f1,fw),"wave-limit water %.2f"%wo, "lat1AU %.3f lat0 %.3f"%(0.51*lex/NA,0.37*lbar/NA))
# ring simulations
dx=0.02; L=24; x=np.arange(-L/2,L/2,dx); X,Y=np.meshgrid(x,x); RHO=np.hypot(X,Y)
def proj(z0,wfun):
    I=np.zeros_like(RHO); m=RHO<R-1e-9
    zz=np.sqrt(R*R-RHO[m]**2); I[m]=R/zz*(wfun(zz-z0)+wfun(-zz-z0))
    return I
def blur(I,s):
    k=np.fft.fftfreq(len(x),dx); KX,KY=np.meshgrid(k,k)
    G=np.exp(-2*np.pi**2*s*s*(KX**2+KY**2))
    return np.real(np.fft.ifft2(np.fft.fft2(I)*G))
res={}
for k,(M,NA) in objs.items():
  for AU in (1,2,4):
    fz=secz(NA,AU,1.33)[3]; sz=fz/2.3548
    wg=lambda z: np.exp(-z*z/(2*sz*sz))
    wl=lambda z: 1/(1+(2*z/fz)**2)
    flat=lambda: None
    fl=0.51*lex/NA; sxy=fl/2.3548
    for name,w in (('G',wg),('L',wl)):
      zs=np.linspace(-30,30,200001); leff=np.trapezoid(w(zs),zs)
      out=[]
      for z0 in (0,1,2,3):
        B=blur(proj(z0,w),sxy)
        row=B[len(x)//2]; i=np.argmax(row); 
        Fint=B.sum()*dx*dx
        zz=np.linspace(-R,R,20001); Fan=2*np.pi*R*np.trapezoid(w(zz-z0),zz)
        out.append((z0,row.max(),abs(x[i]),row[len(x)//2],Fint/(2*np.pi*R*leff),Fan/(2*np.pi*R*leff)))
      print(k,AU,name,"FWHMz %.2f leff %.2f"%(fz,leff),' | '.join("z0=%d pk %.2f r %.2f ctr %.2f Fnorm %.3f/%.3f"%o for o in out))
