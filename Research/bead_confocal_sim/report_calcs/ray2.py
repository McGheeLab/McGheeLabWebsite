import numpy as np
import os; exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ray.py')).read().split('for lab,sinth')[0].replace('app=np.linalg.solve(A,b)','app=np.zeros(3)'))
zs=np.linspace(-3.9,3.9,27)
fz={'20x/0.80':(0.80,2.8,1.138),'10x/0.45':(0.45,9.2,10.86)}
for lab,(NA,f,tc) in fz.items():
    sinth=NA/1.33; f0=(1-np.sqrt(1-sinth**2))/2
    for n_in in (1.33,1.45,1.49,1.59):
        c=np.array([trace(z,n_in,sinth,N=400000)[0]/f0 for z in zs])
        s=f/2.3548
        res=[]
        for z0 in (-2,-1,0,1,2):
            w=np.exp(-(zs-z0)**2/(2*s*s))
            res.append((np.sum(w*c)/np.sum(w), np.sum(w*c*c)/np.sum(w)))
        print(lab,'n=%.2f'%n_in,'c(z) at z=-3,-1,-0.3,0.3,1,3:',' '.join('%.2f'%np.interp(z,zs,c) for z in (-3,-1,-0.3,0.3,1,3)),
              '| F factor (emission only / emission x excitation) z0=-2,-1,0,1,2:',' '.join('%.2f/%.2f'%r for r in res),flush=True)
