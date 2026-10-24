import sys, numpy as np
import os; sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from optics import render, BeadState, ScanSettings, integrated_analytic
def lod(scan, **kw):
    r=render(BeadState(sigma_PE_um2=0.0,**kw),scan,fov_px=34,noise=False)
    yy,xx=np.indices(r['image'].shape); rr=np.hypot(xx-r['centre_px'][0],yy-r['centre_px'][1])*r['px_um']
    m=rr<=6.5; lam=r['mean_pe'][m]
    var=scan.excess_noise_F*np.sum(lam)+m.sum()*(scan.read_noise_DN/scan.gain)**2
    slope=integrated_analytic(BeadState(sigma_PE_um2=1.0),scan)
    return 3*np.sqrt(var)/slope*4*np.pi*16, slope*4*np.pi*16
for P in (10,2):
  for lab,obj,AU in (('20x/0.75 1AU','20x',1),('20x/0.80 1AU','20xD',1),('10x 1AU','10x',1),('10x 4AU','10x',4)):
    sc=ScanSettings(objective=obj,pinhole_AU=AU,px_per_bead=20,laser_uW=P)
    vals=[lod(sc,solution_PE_nM=c)[0] for c in (0,0.1,1,10)]
    ph=lod(sc)[1]
    print(P,'uW',lab,'photons per PE per frame %.3f'%(ph/(4*np.pi*16)*1),' LOD PE/bead (0,0.1,1,10 nM):',' '.join('%.0f'%v for v in vals))
