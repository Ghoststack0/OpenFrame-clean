# Remote phone access

Run `bash install.sh --remote-bundle /trusted/bundle` alongside normal installer options.
Create the administrator account locally BEFORE enabling public access. The relay
operator can read traffic. No managed relay, enrollment API, DNS provisioning or
public HTTPS service is included. No phone VPN is required once the relay works.

The trusted bundle contains a Linux executable named `frpc`, `ca.crt` for the relay,
`url` containing the public HTTPS URL, and `frpc.json` like:

```json
{
  "serverAddr": "relay.example.com", "serverPort": 7000,
  "auth": {"method": "token", "token": "REPLACE_WITH_PRIVATE_RELAY_TOKEN"},
  "transport": {"tls": {"enable": true, "trustedCaFile": "ca.crt", "serverName": "relay.example.com"}},
  "loginFailExit": false,
  "proxies": [{"name": "unique-frame-name", "type": "http", "localIP": "127.0.0.1", "localPort": 2283, "customDomains": ["photos.example.com"]}]
}
```

Use a trusted upstream release matching your architecture and verify its release
checksum before supplying the executable. Tested with frp 0.61.1. Bundle files are
copied privately into INSTALL_DIR/remote; secrets never appear in command arguments.
The installer executes this trusted binary for configuration verification.

The operator must provide frps with token authentication and a certificate matching
serverName, restrict proxy names/domains using server authorization policy, and
terminate public HTTPS with a valid phone-trusted certificate. Forward that HTTPS
virtual host to frps's HTTP vhost port. Keep the HTTP vhost port private, configure
upload body/time limits and WebSockets, and restrict the control port as appropriate.
A shared token alone does not enforce tenant isolation. Use a dedicated relay or
server-side authorization. Do not expose database or cache ports.

frpc retries relay disconnections internally; systemd restarts crashes after ten
seconds. No polling shell process runs. Service start does not prove public HTTPS
readiness. Verify an authenticated phone upload over cellular data. Availability,
bandwidth and storage depend on your relay; no free hosted capacity is promised.
Enable user lingering if it must run after logout. Docker installations also need
a working systemd user session. Existing connector installs are deliberately refused.

Inspect: `systemctl --user status openframe-frpc` and
`journalctl --user -u openframe-frpc`. Disable before normal OpenFrame uninstall:
`systemctl --user disable --now openframe-frpc`, remove the user unit and remote
folder, then `systemctl --user daemon-reload`. Revoke the relay token separately.
Updates require explicitly replacing the connector after stopping it.

References: https://gofrp.org/en/docs/features/common/configure/ and
https://gofrp.org/en/docs/features/common/network/network-tls/ . TLS encryption alone
in frp does not verify the relay; this connector requires a CA and server name.

Validation: `python3 scripts/tests/test-remote.py` checks insecure TLS rejection,
private configuration permissions, service generation and overwrite refusal with
mock systemctl. `python3 scripts/tests/smoke-frpc.py /path/to/frp-release` runs
real TLS-authenticated frpc/frps, echoes a 98,304-byte POST, restarts only its own
relay, and verifies recovery with the original client PID. Local frp 0.61.1 run
observed 15,956 KiB RSS and 0.0% average CPU over a short test, not a sustained
idle benchmark. Public HTTPS termination and real systemd lifecycle were not
exercised by that test. Run these separately on your provisioned deployment.
