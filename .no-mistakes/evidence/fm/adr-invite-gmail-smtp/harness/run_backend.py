"""Run the real backend.main app; only redirect the hard-coded Gmail host to the local SMTP server."""
import os, sys
sys.path.insert(0, os.environ['ADR_ROOT'])
import uvicorn
import backend.workspaces as wm
wm.SMTP_HOST = '127.0.0.1'
wm.SMTP_PORT = int(os.environ['TEST_SMTP_PORT'])
import backend.main as bm
uvicorn.run(bm.app, host='127.0.0.1', port=int(os.environ['TEST_API_PORT']), log_level='warning')
