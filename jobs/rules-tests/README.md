# Firestore rules tests (emulator)

The shared ruleset (`../../firestore.rules`) is deployed to every UNICO app at once, so a
rule change is tested against the emulator BEFORE `node jobs/deployRules.js`.

Run from a scratch folder with the test deps installed (they are not added to this repo,
which is a firebase-admin back-office, not a client):

```bash
mkdir -p ~/laser-rules-test && cd ~/laser-rules-test
npm i @firebase/rules-unit-testing firebase
cp ~/attendance-app/jobs/rules-tests/laser-meter.rules.test.mjs .
cat > firebase.json <<'JSON'
{ "emulators": { "firestore": { "host": "127.0.0.1", "port": 8080 }, "ui": { "enabled": false } },
  "firestore": { "rules": "/home/nishel/attendance-app/firestore.rules" } }
JSON
firebase emulators:exec --only firestore --project unico-operations "node --test laser-meter.rules.test.mjs"
```

Needs Java (present) and the `firebase` CLI (present). No login and no live project are
touched — the emulator is local.

## laser-meter.rules.test.mjs — 20 cases
Meter readings drive `laser_days.kWh` → cost per minute → every margin, so they are
create-only. Covers: staff create allowed; wrong `enteredBy`, overwrite, delete,
`total != A+B`, extra fields, wrong doc id, client clock, negative values all denied;
inactive / unrelated / anonymous users denied on read and write; owner create and
correction allowed (including on a legacy doc with no `enteredBy`/`createdAt`); owner
cannot change the date or delete; correction records are owner-only, require a reason,
and are immutable afterwards.
