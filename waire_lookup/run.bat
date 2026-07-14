@echo off
cd /d "%~dp0"
python -c "import flask" 2>nul || (
    echo Installing dependencies...
    pip install -r requirements.txt
)
start "" "http://127.0.0.1:2305"
python app.py
