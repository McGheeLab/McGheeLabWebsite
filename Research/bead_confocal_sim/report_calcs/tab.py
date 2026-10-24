import numpy as np
lex=0.561;R=4.0;dx=0.01;L=12;x=np.arange(-L/2,L/2,dx)
k=np.fft.fftfreq(len(x),dx); KX,KY=np.meshgrid(k,k)
rng=np.random.default_rng(0); n=3_000_000
z=rng.uniform(-R,R,n); ph=rng.uniform(0,2*np.pi,n); r=np.sqrt(R*R-z*z); px=r*np.cos(ph); py=r*np.sin(ph)
edges=np.append(x,x[-1]+dx)-dx/2
for name,NA,fzs in (('10x/0.45',0.45,{1:9.17,2:14.54}),('20x/0.75',0.75,{1:3.21,2:5.18}),('20x/0.80',0.80,{1:2.80,2:4.54})):
  sxy=0.51*lex/NA/2.3548; G=np.exp(-2*np.pi**2*sxy*sxy*(KX**2+KY**2))
  for AU,fz in fzs.items():
    sz=fz/2.3548; w=lambda t: np.exp(-t*t/(2*sz*sz))
    zz=np.linspace(-30,30,60001); leff=np.trapezoid(w(zz),zz)
    rows=[]
    for z0 in (0,0.5,1,2,3):
      H,_,_=np.histogram2d(py,px,bins=[edges]*2,weights=w(z-z0)*(4*np.pi*R*R/n)); H/=dx*dx
      B=np.real(np.fft.ifft2(np.fft.fft2(H)*G)); c=len(x)//2
      prof=B[c-2:c+3].mean(0)  # central row avg
      # azimuthal radial profile
      XX,YY=np.meshgrid(x,x); RR=np.hypot(XX,YY); rb=np.arange(0,6,0.02); idx=np.digitize(RR.ravel(),rb)
      rad=np.bincount(idx,B.ravel(),len(rb)+1)[1:len(rb)+1]/np.maximum(np.bincount(idx,None,len(rb)+1)[1:len(rb)+1],1)
      i=np.argmax(rad); pk=rad[i]; rr=rb[i]+0.01; ctr=rad[:5].mean()
      ring=rad[(rb>rr-0.5)&(rb<rr+0.5)].mean()
      t=np.linspace(-R,R,8001); F=2*np.pi*R*np.trapezoid(w(t-z0),t)/(2*np.pi*R*leff)
      Fc=np.trapezoid(np.pi*(R*R-t*t)*w(t-z0),t); 
      rows.append((z0,pk,rr,np.sqrt(max(R*R-z0*z0,0)),ctr,ring,F,Fc))
    Fc0=rows[0][7]
    print(name,AU,'AU FWHMz',fz,'leff %.2f'%leff)
    for (z0,pk,rr,rt,ctr,ring,F,Fc) in rows:
      print(f"   z0={z0:3.1f} peak/sig={pk:5.2f} rpk={rr:4.2f} (geom {rt:4.2f}) ctr={ctr:4.2f} ringmean={ring:4.2f} F/plateau={F:5.3f} F/F(0)={F/rows[0][6]:5.3f}  coreF/coreF(0)={Fc/Fc0:5.3f}")
