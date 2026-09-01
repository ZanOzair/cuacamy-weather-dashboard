# Putting CuacaMY on your own domain

Right now the site lives at `https://zanozair.github.io/cuacamy-weather-dashboard/`.
This guide replaces that with a name you own — `cuacamy.com`, `cuacamy.my`,
`cuacamy.com.my`, whatever you register.

**Hosting stays free.** GitHub Pages serves custom domains at no cost and issues a free
HTTPS certificate. The only thing you pay for is the domain name itself.

The repository is already prepared for this: the app uses no absolute URLs, and the deploy
workflow follows your domain automatically once you set it. There are three steps.

---

## Step 1 — Choose and buy a domain

### Which ending should you pick?

| Ending | Who can register it | Rough cost per year | Notes |
|---|---|---|---|
| **`.com`** | Anyone, anywhere | **USD 10–15** (~RM 45–70) | Cheapest and simplest. Recognised everywhere. |
| **`.my`** | Open, including individuals | **RM 60–100** | Short, clearly Malaysian. |
| **`.com.my`** | **Registered Malaysian businesses only** | **RM 80–120** | Needs an SSM registration number — see below. |
| **`.name.my`** | Individuals | **RM 30–60** | Intended for personal names. |

> ### Important about `.com.my`
> `.my` domains are administered by **MYNIC**, Malaysia's national registry. `.com.my` is
> reserved for **registered businesses** — you are normally asked for an SSM company or
> business registration number (ROC/ROB) when you apply.
>
> If you do not have an SSM registration, **`.my` is the one to pick.** It is open to
> individuals, it is just as clearly Malaysian, and `cuacamy.my` reads better than
> `cuacamy.com.my` anyway.
>
> Registry rules change. Confirm the current requirement at **[mynic.my](https://mynic.my/)**
> before paying for anything.

### Where to buy

- **`.my` and `.com.my`** — through a MYNIC-accredited reseller. MYNIC lists them at
  [mynic.my](https://mynic.my/). Well-known Malaysian ones include Exabytes, ServerFreak
  and Shinjiru.
- **`.com`** — [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/) sells
  at cost with no markup and no renewal price rise, which is unusual and worth knowing.
  [Porkbun](https://porkbun.com/) and [Namecheap](https://www.namecheap.com/) are also fine.

### A name that will not embarrass you later

- Short and easy to say over the phone
- No hyphens if you can avoid them — `cuacamy.my` beats `cuaca-my-weather.com`
- Check it is not already a trademark of someone else

---

## Step 2 — Point the domain at GitHub

In your registrar's **DNS settings**, add these records. What you add depends on whether
you want the bare domain, the `www` version, or both. **Both is the right answer** — people
type either one.

### For the bare domain (`cuacamy.my`)

Four **A** records, all with the name `@` (which means the domain itself):

```
@    A    185.199.108.153
@    A    185.199.109.153
@    A    185.199.110.153
@    A    185.199.111.153
```

And four **AAAA** records, so it works over IPv6 too:

```
@    AAAA    2606:50c0:8000::153
@    AAAA    2606:50c0:8001::153
@    AAAA    2606:50c0:8002::153
@    AAAA    2606:50c0:8003::153
```

### For `www.cuacamy.my`

One **CNAME** record:

```
www    CNAME    zanozair.github.io
```

Note there is **no repository name** and **no `https://`** — just the hostname, and many
registrars want a trailing dot: `zanozair.github.io.`

> These are GitHub's published addresses. If a record is rejected or the site will not come
> up, check the current values in
> [GitHub's custom domain documentation](https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site)
> in case they have changed.

### If you use Cloudflare for DNS

Set each record's proxy status to **DNS only** — the **grey** cloud, not the orange one.
With the orange cloud on, Cloudflare sits in front of GitHub and GitHub cannot issue its
certificate, which produces a confusing SSL error that looks like a broken site.

---

## Step 3 — Tell GitHub and this repository

DNS changes take anywhere from a few minutes to a few hours to spread. Do this part after
the records are saved.

### 3a. Add the CNAME file to the repository

**The quick way** — one command does this step and step 4 together:

```bash
node tools/set-domain.mjs cuacamy.my
```

It writes the `CNAME` file, rewrites every link in the README, and prints what still needs
doing outside the repository. To undo it: `node tools/set-domain.mjs --clear`.

**By hand**, if you prefer: create a file called **`CNAME`** — capital letters, no
extension — in the root of the repository, containing **only** your domain:

```
cuacamy.my
```

No `https://`, no trailing slash, no blank lines. `node tools/static-checks.mjs` will tell
you if it is malformed.

> **Do not skip this.** The publish workflow rebuilds the `gh-pages` branch from scratch on
> every deploy. GitHub writes its own CNAME file to that branch when you set a custom domain
> in Settings, and the next deploy would delete it — taking your domain offline until
> someone noticed. Keeping `CNAME` in the repository makes it part of every publish.
>
> The workflow now checks for exactly this and **fails the deploy with an explanation**
> rather than quietly breaking your site.

### 3b. Set it in repository settings

**Settings → Pages → Custom domain** → type your domain → **Save**.

GitHub checks the DNS. When it passes, tick **Enforce HTTPS**. That box may be greyed out
for up to an hour while the certificate is issued — this is normal, come back later.

### 3c. Push

Any push to `main` republishes. The deploy job now verifies **your domain** rather than the
github.io address, so you will see it confirm the real site:

```
Custom domain in use: cuacamy.my
Checking https://cuacamy.my/ for build a8bc3983
Build a8bc3983 live after 2 attempt(s).
```

---

## Step 4 — Update the things that name the old address

Once the domain works, a few places still point at the old one.

| Where | What to change |
|---|---|
| **`README.md`** | Done for you by `node tools/set-domain.mjs`; otherwise replace every `https://zanozair.github.io/cuacamy-weather-dashboard/` |
| **Google sign-in** | If you set it up, add the new origin — see below |
| **Anywhere you shared the link** | Old links keep working: github.io redirects to your domain |

### Google sign-in needs the new address authorised

This one **will** break silently if you forget it, because Google refuses to sign anyone in
from an origin it does not recognise.

1. Go to [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
2. Open your OAuth 2.0 Client ID
3. Add `https://cuacamy.my` to **both** *Authorised JavaScript origins* **and**
   *Authorised redirect URIs*
4. Keep the old github.io entry as well, so both addresses work

### Firebase, if you use it

**Authentication → Settings → Authorized domains** → add your new domain.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| **"Domain does not resolve to the GitHub Pages server"** | DNS has not spread yet, or a record is wrong. Wait, then check with `dig cuacamy.my +short` — it should list the four `185.199.x.153` addresses. |
| **"Enforce HTTPS" is greyed out** | The certificate is still being issued. Up to an hour is normal. |
| **Certificate warning in the browser** | Usually Cloudflare's orange cloud — switch the records to **DNS only**. |
| **The site went back to github.io after a deploy** | The `CNAME` file is missing from the repository. See step 3a. |
| **Google sign-in stopped working** | The new origin is not authorised. See step 4. |
| **`www` works but the bare domain does not** | The A records are missing. Add all four. |

### Checking DNS yourself

```bash
dig cuacamy.my +short          # expect four 185.199.x.153 addresses
dig www.cuacamy.my +short      # expect zanozair.github.io
curl -sSI https://cuacamy.my/  # expect HTTP/2 200
```

---

## What this does not change

- **Hosting stays free.** A custom domain on GitHub Pages costs nothing extra.
- **The app needs no code changes.** Every path inside it is relative.
- **Installed apps keep working.** Anyone who already added CuacaMY to their home screen
  stays on the old address until they reinstall — both keep working, so nothing breaks.
- **The old link keeps working.** GitHub redirects github.io to your domain permanently.
