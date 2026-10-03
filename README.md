# Quizzy Classroom

A teacher can create a quiz, host a room, and share a 6-digit PIN. Students join at the same site with the PIN and a nickname. Rooms support up to 80 students, live answer updates, teacher-controlled answer reveal, automatic 20-second question close, scoring, and a final leaderboard.

## Run the app

Install Node.js 20 or newer, then run from this folder:

```sh
npm start
```

Open `http://localhost:3000` on the teacher's computer. For other devices on the same Wi-Fi, open the teacher computer's local network address at port 3000, such as `http://192.168.1.25:3000`. The computer and network firewall must allow inbound connections to port 3000.

## Deploy publicly from GitHub

This is a Node web service, so GitHub Pages by itself cannot run the live quiz server. The included `render.yaml` describes a Render web service that deploys the repository's `main` branch and checks `/api/health`.

1. Push this repository to GitHub.
2. In Render, create a new **Blueprint** and connect the GitHub repository.
3. Review the service settings from `render.yaml` and deploy.
4. Open the generated `https://…onrender.com` address and share that same address with the teacher and students.

The service must allow long-lived Server-Sent Events connections. Keep one server instance: active room state is held in memory, so restarting or scaling to multiple instances ends rooms or separates players. Quiz definitions are saved in the teacher's browser. Free hosting plans can sleep while idle, so the first visit after a quiet period may need a short wake-up wait.

This app does not require student accounts. PINs are random six-digit codes, and each room accepts at most 80 students. Do not put sensitive student information in nicknames.
