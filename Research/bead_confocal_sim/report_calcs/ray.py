import numpy as np
R=4.0; n_out=1.33
rng=np.random.default_rng(0)
def refract(d,nrm,n1,n2):
    # nrm points against incoming d (into medium 1); returns new dir, tir mask
    c=-np.sum(d*nrm,1); eta=n1/n2; k=1-eta**2*(1-c**2)
    tir=k<0; t=eta*d+(eta*c-np.sqrt(np.maximum(k,0)))[:,None]*nrm
    r=d+2*c[:,None]*nrm
    out=np.where(tir[:,None],r,t); return out/np.linalg.norm(out,axis=1)[:,None], tir
def hit(p,d,inside):
    b=np.sum(p*d,1); c=np.sum(p*p,1)-R*R; disc=b*b-c
    t=np.where(inside,-b+np.sqrt(np.maximum(disc,0)),-b-np.sqrt(np.maximum(disc,0)))
    ok=(disc>0)&(t>1e-9)
    return ok,t
def trace(z,n_in,sinth,N=2_000_000):
    rho=np.sqrt(R*R-z*z); p0=np.array([rho,0,z])*(1+2e-4)
    u=rng.normal(size=(N,3)); d=u/np.linalg.norm(u,axis=1)[:,None]
    p=np.repeat(p0[None],N,0); inside=np.zeros(N,bool); alive=np.ones(N,bool)
    for it in range(6):
        ok,t=hit(p,d,inside); ok&=alive
        if not ok.any(): break
        q=p[ok]+t[ok,None]*d[ok]; nrm=q/R
        ins=inside[ok]
        nn=np.where(ins[:,None],-nrm,nrm)
        n1=np.where(ins,n_in,n_out); n2=np.where(ins,n_out,n_in)
        dd=d[ok]; c=-np.sum(dd*nn,1); eta=n1/n2; k=1-eta**2*(1-c**2); tir=k<0
        tdir=eta[:,None]*dd+(eta*c-np.sqrt(np.maximum(k,0)))[:,None]*nn
        rdir=dd+2*c[:,None]*nn
        newd=np.where(tir[:,None],rdir,tdir); newd/=np.linalg.norm(newd,axis=1)[:,None]
        p[ok]=q; d[ok]=newd; inside[ok]=np.where(tir,ins,~ins)
        # rays that don't hit again are done
    # final: outside rays travelling down within cone
    cos_min=np.sqrt(1-sinth**2)
    col=(~inside)&(d[:,2]<-cos_min)
    frac=col.mean()
    # apparent source: least squares point closest to back-extended collected rays
    P=p[col]; D=d[col]
    A=np.zeros((3,3)); b=np.zeros(3)
    for i in range(0,len(P),200000):
        Pi=P[i:i+200000]; Di=D[i:i+200000]
        M=np.eye(3)[None]-Di[:,:,None]*Di[:,None,:]
        A+=M.sum(0); b+=np.einsum('nij,nj->i',M,Pi)
    app=np.linalg.solve(A,b)
    return frac, app-p0/(1+2e-4)
for lab,sinth in (('20x/0.80',0.80/1.33),('10x/0.45',0.45/1.33)):
    f0=(1-np.sqrt(1-sinth**2))/2
    for n_in in (1.59,1.49):
        out=[]
        for z in (-2,-1,0.25,0.5,1,2,3):
            fr,dp=trace(z,n_in,sinth)
            out.append('z=%+.2f: coll %.2f  shift(x,z)=(%+.2f,%+.2f)'%(z,fr/f0,dp[0],dp[2]))
        print(lab,'n_bead',n_in,'| '+' | '.join(out),flush=True)
