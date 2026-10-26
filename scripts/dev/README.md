# Save local Git checkpoints

Run from this checkout on Linux:

```sh
systemd-run --user --unit=openframe-checkpoints \
  --description='OpenFrame Git checkpoints every 15 minutes' \
  /bin/bash "$PWD/scripts/dev/checkpoint.sh"
```

The loop commits all tracked and untracked changes that Git does not ignore every 15 minutes. Checkpoint commits can contain incomplete work. It skips empty commits and pauses during a merge, rebase, or Git index lock. It never pushes. Keep credentials and local data outside the checkout or in ignored paths.

Inspect or stop the loop:

```sh
systemctl --user status openframe-checkpoints
journalctl --user -u openframe-checkpoints
systemctl --user stop openframe-checkpoints
```

The transient service ends at reboot. Run the start command again when resuming work. The file lock prevents two copies of the loop from committing this checkout concurrently.

For an immediate checkpoint, run `scripts/dev/checkpoint.sh --once`.
