#!/usr/bin/env python3
"""Create the cumulative, runnable source release without duplicate corpus files."""
from pathlib import Path
import argparse
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'package.json').read_text())['version']
EXCLUDED_DIRS = {'node_modules', '.git', '.cache', '__pycache__', 'test-results', 'playwright-report', '.vite', '.temp', '.branches', 'runtime', 'deliverables', 'offline-data'}
EXCLUDED_FILES = {'space-target.json', '.DS_Store', 'prepared-build.json', 'bundle.json'}

def included(path):
    relative=path.relative_to(ROOT)
    if any(part in EXCLUDED_DIRS for part in relative.parts): return False
    if relative.name in EXCLUDED_FILES or relative.suffix in {'.pyc', '.log'}: return False
    if relative.parts[:2] == ('dist', 'data'): return False
    if relative.parts[:3] == ('public', 'data', 'originals'): return False
    if any(part.startswith('.env') and part != '.env.example' for part in relative.parts): return False
    return path.is_file() and not path.is_symlink()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    if not all((ROOT/name).exists() for name in ['dist/index.html','dist/survey.html']): raise SystemExit('Run npm run build first.')
    paths=sorted(p for p in ROOT.rglob('*') if included(p))
    manifest={'application':'Демографическая мастерская','version':VERSION,'stage':'07-offline-classroom','includesStages':[1,2,3,4,5,6,7],'files':[]}
    for path in paths:
        data=path.read_bytes()
        manifest['files'].append({'path':path.relative_to(ROOT).as_posix(),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    prefix=f'demography-workshop-{VERSION}/'
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(args.output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for path in paths:
            info=zipfile.ZipInfo(prefix+path.relative_to(ROOT).as_posix(),date_time=(2026,11,9,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=((0o100755 if path.suffix in {'.command', '.sh'} or path.stat().st_mode & 0o111 else 0o100644)<<16)
            archive.writestr(info,path.read_bytes(),compresslevel=9)
        info=zipfile.ZipInfo(prefix+'RELEASE_MANIFEST.json',date_time=(2026,11,9,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED
        archive.writestr(info,json.dumps(manifest,ensure_ascii=False,indent=2).encode(),compresslevel=9)
    with zipfile.ZipFile(args.output) as archive:
        bad=archive.testzip()
        if bad: raise SystemExit('Invalid member: '+bad)
    digest=hashlib.sha256(args.output.read_bytes()).hexdigest()
    args.output.with_suffix('.sha256').write_text(f'{digest}  {args.output.name}\n')
    print(json.dumps({'file':str(args.output.resolve()),'version':VERSION,'members':len(paths)+1,'bytes':args.output.stat().st_size,'sha256':digest},ensure_ascii=False))

if __name__=='__main__': main()
