#!/bin/bash
# هر دو سرویس را موازی اجرا کن
uvicorn main:app --host 0.0.0.0 --port 8000 &
python clamd_proxy.py &
wait
