import os, subprocess, hashlib, json, sys, re
from pathlib import Path
base=Path(sys.argv[3]); base.mkdir(parents=True, exist_ok=True)
reference=Path(sys.argv[1]); target=Path(sys.argv[2])
fixtures=base/'fixtures'; fixtures.mkdir(exist_ok=True)
def run(root, tool, *args):
 env=dict(os.environ, LD_LIBRARY_PATH=f'{root}/prefix/lib:{root}/sysroot/usr/lib/x86_64-linux-gnu', MAGICK_CONFIGURE_PATH=str(root/'prefix/etc/ImageMagick-7'))
 return subprocess.check_output([str(root/'prefix/bin'/tool),*map(str,args)],env=env,stderr=subprocess.PIPE)
def libraries(root):
 result={}
 for p in (root/'prefix/lib').rglob('*.so*'):
  if p.is_file():
   dynamic=subprocess.check_output(['readelf','-d',str(p)],stderr=subprocess.DEVNULL,text=True)
   result[str(p.relative_to(root/'prefix/lib'))]=re.findall(r'\(SONAME\).*?\[(.*?)\]',dynamic)
 return result
results={}
a,b=libraries(reference),libraries(target)
results['libraries']={'equal':a==b,'missing':sorted(a.keys()-b.keys()),'extra':sorted(b.keys()-a.keys()),'sonames_changed':[k for k in a.keys()&b.keys() if a[k]!=b[k]]}
for tool,args in [('vips',['--vips-config']),('vips',['-l','foreign']),('magick',['-list','format']),('magick',['-list','configure'])]:
 a,b=run(reference,tool,*args),run(target,tool,*args)
 if args[-1]=='configure':
  a=b'\n'.join(x for x in a.splitlines() if re.match(rb'(DELEGATES|FEATURES)\s',x))
  b=b'\n'.join(x for x in b.splitlines() if re.match(rb'(DELEGATES|FEATURES)\s',x))
 key=tool+' '+' '.join(args)
 a=a.replace(str(reference).encode(), b'<CODECS>'); b=b.replace(str(target).encode(), b'<CODECS>')
 results[key]={'equal':a==b}
 (base/(key.replace(' ','_')+'-reference.txt')).write_bytes(a)
 (base/(key.replace(' ','_')+'-new.txt')).write_bytes(b)
for ext in ['png','jpg','tiff','webp','avif','jxl']:
 p=fixtures/f'gradient.{ext}'
 if not p.exists(): run(reference,'magick','-size','64x48','gradient:#d94221-#174ad6',p)
svg=fixtures/'shapes.svg';svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#1844aa"/><circle cx="25" cy="20" r="12" fill="#ee5533"/></svg>')
for p in sorted(fixtures.iterdir()):
 if p.suffix not in ['.png','.jpg','.tiff','.webp','.avif','.jxl','.svg']: continue
 for tool in ['vips','magick']:
  if tool=='magick' and p.suffix=='.svg':
   errors=[]
   for root in [reference,target]:
    try: run(root,tool,p,'-depth','8',f'rgba:{base}/svg.raw')
    except subprocess.CalledProcessError as error:
     errors.append((error.returncode,b'security policy' in error.stderr,b'inkscape' in error.stderr))
    else: errors.append((0,False,False))
   results[f'{tool} {p.name}']={'equal':errors[0]==errors[1] and errors[0]==(1,True,True),'blocked_by_existing_policy':True,'errors':errors}
   continue
  hashes=[]
  for label,root in [('reference',reference),('new',target)]:
   raw=base/f'{label}.raw'
   if tool=='magick': run(root,tool,f'msvg:{p}' if p.suffix=='.svg' else p,'-depth','8',f'rgba:{raw}')
   else: run(root,tool,'rawsave',p,raw)
   pixels=raw.read_bytes();raw.unlink()
   hashes.append(hashlib.sha256(pixels).hexdigest())
  results[f'{tool} {p.name}']={'equal':hashes[0]==hashes[1],'sha256':hashes}
(base/'parity.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results,indent=2))
assert all(x['equal'] for x in results.values())
