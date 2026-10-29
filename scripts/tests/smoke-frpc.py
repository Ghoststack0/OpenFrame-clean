"""Run with a directory containing real frpc and frps. Uses only owned processes."""
import http.server, json, pathlib, socket, subprocess, sys, tempfile, threading, time, urllib.request

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

class Upload(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args): pass

binary = pathlib.Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory() as tmp:
    d = pathlib.Path(tmp)
    control, public = port(), port()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Upload)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(d/'key'), '-out', str(d/'ca.crt'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (d/'server.json').write_text(json.dumps({'bindAddr':'127.0.0.1','bindPort':control,'vhostHTTPPort':public,'auth':{'method':'token','token':'isolated-test'},'transport':{'tls':{'force':True,'certFile':str(d/'ca.crt'),'keyFile':str(d/'key')}}}))
    (d/'client.json').write_text(json.dumps({'serverAddr':'127.0.0.1','serverPort':control,'loginFailExit':False,'auth':{'method':'token','token':'isolated-test'},'transport':{'tls':{'enable':True,'serverName':'localhost','trustedCaFile':str(d/'ca.crt')}},'proxies':[{'name':'upload','type':'http','localIP':'127.0.0.1','localPort':server.server_port,'customDomains':['photos.test']}]}))
    processes=[]
    def start(name, config):
        p=subprocess.Popen([str(binary/name), '-c', str(d/config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(p)
        return p
    def upload():
        for _ in range(200):
            try:
                payload=b'photo-upload-through-frp'*4096
                req=urllib.request.Request(f'http://127.0.0.1:{public}/upload', data=payload, headers={'Host':'photos.test'})
                with urllib.request.urlopen(req, timeout=1) as r:
                    assert r.read()==payload
                return
            except (OSError, AssertionError): time.sleep(.1)
        raise AssertionError('Tunnel did not recover')
    try:
        relay=start('frps','server.json')
        client=start('frpc','client.json')
        upload()
        relay.terminate(); relay.wait()
        time.sleep(1)
        start('frps','server.json')
        upload()
        assert client.poll() is None
        print('PASS: 98304-byte HTTP upload and relay restart recovery with same frpc PID')
        print(subprocess.check_output(['ps','-p',str(client.pid),'-o','rss=,%cpu='], text=True).strip(), '(RSS KiB, average CPU %)')
    finally:
        for p in processes:
            if p.poll() is None: p.terminate()
        for p in processes: p.wait(timeout=10)
        server.shutdown()
