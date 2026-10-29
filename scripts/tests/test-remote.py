import json, os, pathlib, subprocess, tempfile, unittest
SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'remote/install-frpc'
class Connector(unittest.TestCase):
    def test_install_and_refuse_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=pathlib.Path(tmp); b=d/'bundle'; b.mkdir(); tools=d/'bin'; tools.mkdir()
            (tools/'systemctl').write_text('#!/bin/sh\nexit 0\n'); (tools/'systemctl').chmod(0o700)
            (b/'frpc').write_text('#!/bin/sh\nexit 0\n'); (b/'frpc').chmod(0o700)
            (b/'ca.crt').write_text('test CA'); (b/'url').write_text('https://photos.example.com')
            config={'serverAddr':'relay.example.com','serverPort':7000,'auth':{'method':'token','token':'private'},'transport':{'tls':{'enable':True,'trustedCaFile':'ca.crt','serverName':'relay.example.com'}},'loginFailExit':False,'proxies':[{'name':'frame','type':'http','localIP':'127.0.0.1','localPort':2283,'customDomains':['photos.example.com']}]}
            env={**os.environ,'XDG_CONFIG_HOME':str(d/'config'),'PATH':str(tools)+':'+os.environ['PATH']}
            def run():
                return subprocess.run([str(SCRIPT),str(b),str(d/'remote'),'2283'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            config['transport']['tls']['enable']=False
            (b/'frpc.json').write_text(json.dumps(config))
            self.assertNotEqual(run().returncode,0); self.assertFalse((d/'remote').exists())
            config['transport']['tls']['enable']=True
            (b/'frpc.json').write_text(json.dumps(config))
            self.assertEqual(run().returncode,0)
            self.assertEqual((d/'remote/frpc.json').stat().st_mode & 0o777,0o600)
            self.assertIn('Restart=always',(d/'config/systemd/user/openframe-frpc.service').read_text())
            self.assertNotEqual(run().returncode,0)
unittest.main()
