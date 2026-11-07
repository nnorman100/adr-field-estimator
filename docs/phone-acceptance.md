# Phone acceptance script

A short check the owner runs on a real phone before a release is marked phone-checked in
`docs/STATUS.md`. Automated and browser tests cannot prove camera and microphone release, Bluetooth
audio, iPhone screen behavior, network handoffs or conversational speed; only a real phone can.

## Which phone

- **Required:** the company's oldest iPhone still in use, running **iOS 16.4 or newer**. Write
  down its model and exact iOS version (Settings → General → About) before you start.
- **Optional, if handy:** a current iPhone, or an Android phone in Chrome. Run the same checks and
  note any difference.

Use the app added to the Home Screen (check 1), not a Safari tab, unless a check says otherwise.

## Before you start

- Use a made-up job only: customer `Synthetic Homeowner`, address `123 Synthetic Lane,
  Bakersfield, CA 93308`. Never a real customer.
- Sign in with the company owner account.
- Have a Bluetooth earpiece paired, good Wi-Fi or cellular, and a spot with weak signal nearby (a
  basement, metal building or the back of a warehouse).
- If a check does not match what it says, stop and write down: the check number, what you saw
  (a screenshot helps), the network (Wi-Fi, cellular, weak, Airplane mode) and the earpiece.

## The checks

Each line is what you do, then what you should see.

**Getting in**

1. In Safari, open the app, tap **Share** → **Add to Home Screen** → **Add**, then open it from the
   Home Screen. → The name is **DryScope** and the app fills the screen with no Safari bars.
2. Sign in (email and password, or **Sign in with Google**). → You land on the dashboard; the
   Google window closes by itself and returns to the app.
3. Tap **+ New job**, then open **Check Scope**, type the made-up address in **Property
   address** and `1985` in **Year built**. → The job first opens on **Walk & Photo**; after
   typing, the address shows at the top, the status settles on **Saved**, and the top bar does
   not jump.

**Photos and working offline**

4. Go back to **Walk & Photo**, tap **Capture photo** and take a portrait photo. → The photo is upright and not stretched, and
   it appears under **Photos**.
5. Turn on Airplane mode. In **Check Scope**, tap **Add room** and type a measurement; go back to
   **Walk & Photo** and capture a photo. → The status reads **Offline · saved on phone**.
6. Still in Airplane mode, swipe the app closed and reopen it from the Home Screen. → The app
   opens, and the new room, the measurement and the photo are all still there.
7. Still in Airplane mode, tap **Offline notes** → **Record voice note**, describe the room for
   20 seconds ("Kitchen, category two, fifty square feet of drywall removed"), lock the phone for
   10 seconds, unlock it and tap **Stop and save note**. → The note is listed
   under **Voice notes**.
8. Turn Airplane mode off, wait a minute, then tap **Review transcript**. → The status goes
   **Saving…** then **Saved**, each photo shows once, the voice note's words appear in the
   walkthrough transcript, and the app opens **Check Scope** with the **Scope from walkthrough**
   summary filled from the note.

**Live walkthrough with the earpiece**

9. With the earpiece connected, go back to **Walk & Photo**, tap **Back to live assistant** and
   allow camera and microphone; open **More walkthrough options**. → **Live AI connected** shows,
   the assistant speaks first in the earpiece, and what you say about the room appears under
   **Technician observations**.
10. While the assistant is talking, interrupt it ("Stop, let's do the bedroom"). → It stops at
    once, no leftover sentence plays, and it answers the new request.
11. Ask five short questions and time each gap between finishing your sentence and the first
    sound of the answer. → Each is about one second or less; write the five times down.
12. Walk into the weak-signal spot and keep talking for 30 seconds. → **Weak signal: video
    paused, voice may be delayed** shows, voice keeps working, and after about 25 seconds the app
    offers **Switch to offline notes** (tap **Not now**).
13. Back on good signal, turn on Airplane mode for 10 seconds, turn it off, then tap **Resume
    walkthrough**. → While offline: **Not connected**, the offer to switch to offline notes, and
    the green and orange dots at the top of the screen go out; earlier observations stay. After
    resuming: **Live conversation resumed** or **Live restarted using saved inspection**, and no
    earlier audio is played again.
14. Tap **Stop walkthrough**. → The green camera dot and orange microphone dot go out within a
    second, and the top bar does not jump.

**Review and sign**

15. Tap **Fill scope from walkthrough**, then **Confirm scope**; check the numbers in **Check
    Scope**, tick the "I confirmed room quantities…" box and tap **Finish & review** (if **Ready to
    review?** opens, tap **Continue to review anyway**). In **Review & Sign**, open **Proposal**, **Itemized claim**, **Defense letter** and **Photo audit log**, tick
    "I reviewed the proposal…", sign with your finger and tap **Authorize & sign**. → All four
    documents open with no blanks, **Proposal** and **Defense letter** show the company
    letterhead, and the status at the top reads **Signed**.

## Record the result

| Phone model and iOS | Earpiece | Date | Checks passed | Checks failed (number and what you saw) |
|---|---|---|---|---|
| | | | | |

When every check passes on the required phone, mark the features it covers as phone-checked in
`docs/STATUS.md` with the phone model and iOS version. If a check fails, open an issue with the
check number and what you saw.
