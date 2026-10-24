import numpy as np
from scipy.integrate import solve_ivp
NA=6.022e23
R=4e-4 # cm
def kD(D): return 4*np.pi*R*D*NA/1000  # M^-1 s^-1 per bead
for D in [8.5e-7,6e-7,3.89e-7,3e-7]:
    print("D",D,"kD %.3g"%kD(D), "a2/D %.3g s"%(R**2/D))
# reference
NS=1e6; nb=1e4; V=50e-6
cb=nb/(NA*V); ST=cb*NS
print("cb %.3g M  ST %.3g M  phi %.3g  spacing um %.3g"%(cb,ST, nb*(4/3*np.pi*(4e-4)**3)/(V*1000), (V*1e-3/nb)**(1/3)*1e6))
k1=5e5; km1=1e-5; k2=4e5; km2=8.6e-4; DT=2e-9
DA=6e-7; DD=3.5e-7; DAD=3.0e-7
kDA,kDD,kDAD=kD(DA),kD(DD),kD(DAD)
print("Da1",k1*NS/kDA,"Da3",k1*NS/kDAD)
def rhs(t,y,AT):
    A,D,AD,SA,SAD=y
    S=ST-SA-SAD
    Nfree=S/cb  # free sites per bead
    f1=1/(1+k1*Nfree/kDA); f3=1/(1+k1*Nfree/kDAD)
    NSA=SA/cb; f2=1/(1+k2*NSA/kDD)
    r1=k1*f1*A*S - km1*f1*SA
    r3=k1*f3*AD*S - km1*f3*SAD
    r2=k2*f2*D*SA - km2*f2*SAD
    r4=k2*A*D - km2*AD
    return [-r1-r4, -r2-r4, r4-r3, r1-r2, r2+r3]
def run(AT,t):
    s=solve_ivp(rhs,[0,t],[AT,DT,0,0,0],args=(AT,),method='LSODA',rtol=1e-8,atol=1e-22)
    return s.y[:,-1]
def eq(AT):
    K1=km1/k1; K2=km2/k2
    b=((K1+ST+AT)-np.sqrt((K1+ST+AT)**2-4*ST*AT))/2
    Df=(-(K2+AT-DT)+np.sqrt((K2+AT-DT)**2+4*K2*DT))/2
    return b, Df/(K2+Df)
print("K1 %.3g K2 %.3g"%(km1/k1,km2/k2))
print("AT(M)  N_PE_eq  N_PE_1h  N_PE_3h  capfrac1h  fD1h")
for AT in [1e-15,1e-14,1e-13,1e-12,1e-11,1e-10,1e-9,3e-9,1e-8,1e-7,1e-6]:
    b,fD=eq(AT)
    y1=run(AT,3600); y3=run(AT,3*3600)
    print("%.0e  %.3g  %.3g  %.3g  %.3g  %.3g"%(AT, b*fD/cb, y1[4]/cb, y3[4]/cb, (y1[3]+y1[4])/AT, y1[4]/(y1[3]+y1[4]+1e-300)))
# capture rate
kb=lambda k,N,Dd: kD(Dd)*N*k/(kD(Dd)+N*k)
for nbx in [1e3,1e4,1e5]:
    cbx=nbx/(NA*V); kc=cbx*kb(k1,NS,DA)
    print("nb",nbx,"kcap %.3g s^-1 tau %.3g min, frac1h %.3g"%(kc,1/kc/60,1-np.exp(-kc*3600)))
# flux at concentrations
for c in [1e-15,1e-12,1e-9]:
    print("flux",c,"%.3g /s"%(kD(DA)*c), "per h %.3g"%(kD(DA)*c*3600))
# photophysics
eps=1.96e6; sigma=3.82e-21*eps; tau=2.7e-9
Isat=1/(sigma*tau); print("sigma %.3g Isat %.3g"%(sigma,Isat))
h=6.626e-34;c=3e8;lam=561e-9;E=h*c/lam
for NAo in [0.45,0.75,0.8]:
    w0=0.42*0.561/NAo*1e-4
    P=Isat*np.pi*w0**2/2*E
    print("NA",NAo,"w0 um %.3g Psat uW %.3g"%(w0*1e4,P*1e6))
print("kbl max %.3g s^-1"%(1.1e-5/tau))
# PE decay windows
for k in [8.6e-4,1e-4]:
    print(k,[round(1-np.exp(-k*t*60),3) for t in [5,15,30,60,120]])
# sedimentation
v=2/9*50*9.81*(4e-6)**2/1e-3; print("vsed um/s",v*1e6,"Pe",v*4e-6/(DA*1e-4))
H=0.15
print("H^2/2D h", H**2/(2*DA)/3600, H**2/(2*DD)/3600)
# steric
for dnm in [11,15,18,20]:
    a=np.pi*(dnm/2)**2/0.547
    print(dnm,"nm footprint/jam %.0f nm2  max per bead %.3g per um2 %.0f"%(a,201e6/a,1e6/a))
print("Chang density 8um: %.3g"%(274000*(8/2.5)**2))
