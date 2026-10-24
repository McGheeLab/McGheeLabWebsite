import numpy as np
NA=6.022e23; V=50e-6; nb=1e4; NS=1e6; cb=nb/NA/V; ST=cb*NS
K1=20e-12; k2=4e5; km2=8.6e-4; K2=km2/k2
def eq(A,DT,K2=K2):
    B=0.5*((K1+ST+A)-np.sqrt((K1+ST+A)**2-4*ST*A))
    Df=0.5*(-(K2+A-DT)+np.sqrt((K2+A-DT)**2+4*K2*DT))
    return B/ST*Df/(K2+Df)*NS, Df
print('S_T nM %.3f K2 nM %.2f'%(ST*1e9,K2*1e9))
As=np.logspace(-15,-5,4001)
for DT in (1e-9,2e-9,5e-9,1e-8,2e-8):
    N,_=eq(As,DT); i=np.argmax(N)
    n1,Df=eq(1e-12,DT); fD=Df/(K2+Df)
    h=1e-4; s=(np.log(eq(1e-12,DT,K2*(1+h))[0])-np.log(n1))/h   # dlnN/dlnK2 at fixed k2 == dln/dln k-2
    g1=k2*DT/(k2*DT+km2)*(1-np.exp(-(k2*DT+km2)*3600))
    # concentration where signal falls back to 50% of peak on falling branch
    j=i+np.argmax(N[i:]<0.5*N[i])
    print('DT %4.0f nM  fD(eq) %.2f  g(1h) %.2f  sens %.2f  peak A %.2g nM  N_peak %.2g  half-peak on falling branch %.2g nM  N at 1pM %.0f'%(DT*1e9,fD,g1,s,As[i]*1e9,N[i],As[j]*1e9,n1))
