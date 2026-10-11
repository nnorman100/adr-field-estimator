import sys
from pathlib import Path
dependency_dir=Path(__file__).resolve().parents[1]/'.test-deps'
if dependency_dir.exists():sys.path.insert(0,str(dependency_dir))
