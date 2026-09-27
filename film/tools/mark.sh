#!/bin/zsh
# mark.sh <name> <label>: note the time of a take event (read by prep3.sh)
echo "$2 $(python3 -c 'import time;print(int(time.time()*1000))')" >> ${0:A:h}/../raw/$1.marks
