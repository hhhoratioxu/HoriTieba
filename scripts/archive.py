"""Create portable release ZIPs, keeping an already identical binary archive intact."""
from pathlib import Path
import sys
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile

source, output = (Path(value).resolve() for value in sys.argv[1:])
files = {f.relative_to(source.parent).as_posix(): f for f in sorted(source.rglob('*')) if f.is_file()}

# Repackaging new evidence must preserve the exact Chrome ZIP used in the native test.
if output.is_file():
    try:
        with ZipFile(output) as archive:
            entries = [entry.filename for entry in archive.infolist() if not entry.is_dir()]
            if len(entries) == len(files) and set(entries) == set(files) and all(
                archive.read(name) == file.read_bytes() for name, file in files.items()
            ):
                sys.exit(0)
    except (BadZipFile, OSError):
        pass

pending = output.with_suffix('.zip.tmp')
try:
    with ZipFile(pending, 'w', compression=ZIP_DEFLATED) as archive:
        for name, file in files.items():
            archive.write(file, name)
    pending.replace(output)
finally:
    pending.unlink(missing_ok=True)
