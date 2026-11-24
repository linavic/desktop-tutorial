import numpy as np, wave
SR=44100; DUR=26.5
n=int(SR*DUR); t=np.arange(n)/SR
rng=np.random.default_rng(7)
def note(f): return 440*2**((f-69)/12)
def env(t0,dur,a,r,length):
    e=np.zeros(length); i0=int(t0*SR); i1=min(length,int((t0+dur)*SR))
    x=np.arange(i1-i0)/SR
    e[i0:i1]=np.minimum(1,x/a)*np.exp(-np.maximum(0,x-(dur-r))*0+0)*np.minimum(1,(dur-x)/r)
    return e
out=np.zeros(n)
# --- pad: Am9 -> Fmaj7 -> Cmaj9 -> G6 (soft, slow attack), 6.6s per chord
chords=[[57,60,64,67,71],[53,57,60,64,67],[48,55,60,64,67],[55,59,62,64,67]]
seg=6.65
for i,ch in enumerate(chords):
    t0=i*seg-0.3 if i else 0
    dur=seg+0.9 if i else seg+0.6
    e=np.zeros(n); i0=max(0,int(t0*SR)); i1=min(n,int((t0+dur)*SR)); x=np.arange(i1-i0)/SR
    e[i0:i1]=np.minimum(1,x/1.6)*np.minimum(1,(dur-x)/1.4)
    for m in ch:
        f=note(m)
        for d in (-0.35,0.0,0.35):  # detuned stack
            out+=0.045*e*np.sin(2*np.pi*(f*2**(d/1200))*t+rng.uniform(0,6))
    out+=0.07*e*np.sin(2*np.pi*note(ch[0]-12)*t)   # sub bass
# --- soft pulse lfo for movement
out*=0.85+0.15*np.sin(2*np.pi*t/6.65)
# --- chimes (pentatonic bells) synced to the visuals
def bell(t0,m,vel=0.22):
    global out
    i0=int(t0*SR); L=int(2.2*SR); x=np.arange(L)/SR
    f=note(m); s=np.zeros(L)
    for k,(h,a) in enumerate([(1,1),(2.01,.45),(3.02,.2),(4.2,.1)]):
        s+=a*np.sin(2*np.pi*f*h*x)*np.exp(-x*(2.4+k*1.8))
    s*=np.minimum(1,x/0.004)
    j=min(n,i0+L); out[i0:j]+=vel*s[:j-i0]
scale=[81,84,86,88,91,93]  # A5 C6 D6 E6 G6 A6
for i in range(6): bell(3.6+i*1.0+0.05,scale[i])            # zone highlights
bell(12.9,76,.16)
for i in range(5): bell(12.9+i*.62+.05,[76,79,81,83,86][i],.14) # steps
for k,m in enumerate([81,86,91,93]): bell(18.0+k*0.14,m,.2)   # CTA arrival arpeggio
bell(19.6,93,.12); bell(22.8,88,.1)
# --- gentle air/noise shimmer
nz=rng.normal(0,1,n); 
k=np.ones(400)/400; nz=nz-np.convolve(nz,k,'same')   # highpass-ish
out+=0.006*nz*(0.5+0.5*np.sin(2*np.pi*t/9))
# master: fades + soft limiter
fi=np.minimum(1,t/1.2); fo=np.minimum(1,(DUR-t)/2.0)
out*=fi*fo
out=np.tanh(out*1.6)/1.6
out/=np.max(np.abs(out))/0.55
# stereo: slight haas widening
L=out; R=np.roll(out,int(0.011*SR))
st=np.stack([L,R],1)
pcm=(st*32767).astype('<i2')
w=wave.open('assets/bg-music.wav','wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes()); w.close()
print('audio ok')
