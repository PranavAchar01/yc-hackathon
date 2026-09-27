#!/bin/zsh
# Synthesize the film's sound effects (quiet, Apple-like, under a voiceover). Output: film/sfx/<name>.wav
set -eu
cd ${0:A:h}/../sfx
A=(-v error -y)
# click: a 12 ms tick, bright and soft
ffmpeg $A -f lavfi -i "aevalsrc='(random(0)*2-1)*exp(-t*900)*0.6+sin(2*PI*2400*t)*exp(-t*700)*0.35':s=48000:d=0.05" -af "highpass=f=900,lowpass=f=7000" click.wav
# type: keyboard taps across 1.6 s
ffmpeg $A -f lavfi -i "aevalsrc='(random(0)*2-1)*0.45*(exp(-mod(t,0.13)*420))*gt(mod(t*7.7+sin(t*9),1),0.35)':s=48000:d=1.6" -af "highpass=f=1200,lowpass=f=6000,afade=t=out:st=1.4:d=0.2" type.wav
# whoosh: filtered noise swelling and falling over 0.7 s
ffmpeg $A -f lavfi -i "anoisesrc=color=pink:amplitude=0.6:d=0.7:r=48000" -af "bandpass=f=1400:width_type=o:w=1.4,afade=t=in:d=0.35:curve=qsin,afade=t=out:st=0.35:d=0.35:curve=qsin,volume=0.8" whoosh.wav
# swoosh: softer, lower whoosh for a new scene
ffmpeg $A -f lavfi -i "anoisesrc=color=brown:amplitude=0.7:d=0.9:r=48000" -af "bandpass=f=700:width_type=o:w=1.6,afade=t=in:d=0.45:curve=qsin,afade=t=out:st=0.45:d=0.45:curve=qsin,volume=0.6" swoosh.wav
# chime: a clean two-note ding (E6 then B6), gentle decay
ffmpeg $A -f lavfi -i "aevalsrc='0.32*sin(2*PI*1318.5*t)*exp(-t*5)+0.26*sin(2*PI*1975.5*t)*exp(-(t-0.09)*5)*gt(t,0.09)+0.05*sin(2*PI*2637*t)*exp(-t*9)':s=48000:d=1.1" -af "afade=t=in:d=0.004" chime.wav
# pop: a short rounded blip as a circle is drawn
ffmpeg $A -f lavfi -i "aevalsrc='0.5*sin(2*PI*(520+900*exp(-t*40))*t)*exp(-t*22)':s=48000:d=0.2" -af "afade=t=in:d=0.003" pop.wav
# tab: a light tick plus a short air, a new browser tab opening
ffmpeg $A -f lavfi -i "aevalsrc='(random(0)*2-1)*exp(-t*600)*0.4':s=48000:d=0.05" -f lavfi -i "anoisesrc=color=pink:amplitude=0.4:d=0.3:r=48000" -filter_complex "[1]bandpass=f=2500:width_type=o:w=1,afade=t=in:d=0.12,afade=t=out:st=0.12:d=0.18[n];[0][n]amix=inputs=2:normalize=0,highpass=f=600" tab.wav
ls
