"""Legacy entrypoint; verify 165 paper with the unchanged original asset and checks."""
import pathlib, runpy
runpy.run_path(str(pathlib.Path(__file__).with_name("verify-paper165.py")), run_name="__main__")
