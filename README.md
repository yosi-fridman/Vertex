# vertex-key-check

בדיקת מפתח ל‑Google Cloud **AI Platform / Vertex AI** — כלי CLI ב‑JavaScript (Node.js + axios)
שבודק האם המפתח שקיבלת באמת עובד, מול איזה **region**, ובאיזו **כתובת URL** בדיוק.

ברירת המחדל היא לעבוד מול הריג'ן של המזרח התיכון — תל אביב:

```
https://me-west1-aiplatform.googleapis.com
```

ואם הוא לא עונה, הכלי נופל לריג'נים אחרים לפי סדר: `me-central1 → me-central2 → europe-west4 → europe-west1 → us-central1`.

הכלי **אף פעם לא מדפיס את המפתח הפרטי** — לא בלוג, לא ב‑`--verbose`, ולא ב‑URL.

---

## התקנה

```bash
npm install
cp .env.example .env      # וערוך את .env
```

דרישה: Node.js 18 ומעלה.

## הרצה

```bash
# הדרך הרגילה — קובץ ה‑JSON של ה‑service account
node src/index.js --key ./secrets/vertex-sa.json

# או דרך משתנה סביבה
export GOOGLE_APPLICATION_CREDENTIALS=./secrets/vertex-sa.json
npm run check

# לראות את כל הבקשות והתשובות (מפתחות מוסתרים)
npm run check:verbose

# גם לשלוח בקשת generateContent אמיתית (עולה כמה טוקנים)
npm run check:generate

# פלט JSON לסקריפטים / CI
node src/index.js --json
```

## מה הכלי עושה בפועל

### שלב 1 — הפיכת המפתח לטוקן

קובץ ה‑service account לא נשלח ל‑Vertex. חותמים איתו JWT ומחליפים אותו בטוקן:

```
POST https://oauth2.googleapis.com/token
      grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
      assertion=<JWT חתום ב‑RS256>
```

ה‑JWT נבנה ונחתם ידנית ב‑`src/auth.js` עם `node:crypto` — בלי `google-auth-library` —
כדי שגם כתובת ה‑token תהיה גלויה כמו כל השאר. התוצאה נשלחת כ‑`Authorization: Bearer <token>`.

### שלב 2 — בדיקות לכל ריג'ן

לכל ריג'ן, לפי הסדר, נשלחות הבקשות הבאות עם axios:

| # | בדיקה | כתובת |
|---|-------|-------|
| 1 | `location` | `GET https://me-west1-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/me-west1` |
| 2 | `publisherModels` | `GET https://me-west1-aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=5` |
| 3 | `customModels` | `GET https://me-west1-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/me-west1/models?pageSize=1` |
| 4 | `generateContent` *(רק עם `--generate`)* | `POST https://me-west1-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/me-west1/publishers/google/models/{MODEL}:generateContent` |

כל הכתובות מרוכזות במקום אחד — `src/regions.js`, באובייקט `urls`.

בדיקה 1 מוכיחה שהאנדפוינט הריג'ונלי קיים ושהמפתח מזוהה.
בדיקה 3 היא זו שמוכיחה הרשאות **על הפרויקט** (IAM), ולא רק שהחתימה תקינה.

### שלב 3 — פסק דין

| תוצאה | משמעות |
|-------|---------|
| `OK` | כל הבדיקות עברו — המפתח עובד מול הריג'ן הזה |
| `PARTIAL` | האנדפוינט עונה והמפתח תקף, אבל משהו חסר (בדרך כלל IAM או API שלא הופעל) |
| `FAIL` | המפתח נדחה, או שהריג'ן לא קיים / לא נגיש |

קודי יציאה: `0` = לפחות ריג'ן אחד תקין, `1` = אף ריג'ן לא עבד, `2` = שגיאת שימוש או מפתח פגום.

אם התקבל `401` כבר בריג'ן הראשון, הכלי מפסיק — זו בעיה במפתח עצמו, לא בריג'ן,
ואין טעם לחזור על אותה דחייה שש פעמים. `--all` מכריח לבדוק הכול.

---

## דוגמת פלט

```
Step 1 - exchange the signed JWT for an access token
----------------------------------------------------
  → POST https://oauth2.googleapis.com/token
  ← 200 312ms
  ✓ got a Bearer token, valid for 3599s

Step 2 - probe regions (6 in order, preferred first)
----------------------------------------------------
  order: me-west1 -> me-central1 -> me-central2 -> europe-west4 -> europe-west1 -> us-central1

▸ me-west1  https://me-west1-aiplatform.googleapis.com
  → GET https://me-west1-aiplatform.googleapis.com/v1/projects/my-proj/locations/me-west1
  ← 200 141ms
  → GET https://me-west1-aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=5
  ← 200 128ms
  → GET https://me-west1-aiplatform.googleapis.com/v1/projects/my-proj/locations/me-west1/models?pageSize=1
  ← 200 119ms
  ✓ OK - all probes passed

Summary
-------
REGION    ENDPOINT                            RESULT  TIME   DETAIL
me-west1  me-west1-aiplatform.googleapis.com  OK      388ms  all probes passed

✓ The key works.
  endpoint: https://me-west1-aiplatform.googleapis.com
  region:   me-west1
```

---

## אפשרויות

| דגל | תיאור |
|-----|--------|
| `--key <file\|json>` | קובץ JSON של service account, JSON ישירות, או מפתח `AIza...` |
| `--project <id>` | מזהה הפרויקט. ברירת מחדל: ה‑`project_id` מקובץ המפתח |
| `--region <r>` | הריג'ן המועדף. ברירת מחדל `me-west1` |
| `--regions <a,b,c>` | רשימת הנפילה המלאה, לפי סדר |
| `--only-preferred` | בלי fallback — לבדוק רק את הריג'ן המועדף |
| `--all` | לבדוק את כל הריג'נים גם אחרי הצלחה (טוב למיפוי זמינות) |
| `--generate` | לשלוח גם בקשת `generateContent` אמיתית |
| `--model <name>` | המודל ל‑`--generate`. ברירת מחדל `gemini-2.5-flash` |
| `--timeout <ms>` | timeout לכל בקשה. ברירת מחדל 20000 |
| `--json` | פלט JSON ב‑stdout (הלוג עובר ל‑stderr) |
| `--verbose` | להדפיס headers ו‑bodies, עם הסתרת סודות |

## סוגי מפתחות נתמכים

1. **Service account JSON** — המקרה הרגיל. `GOOGLE_APPLICATION_CREDENTIALS` או `--key`.
2. **JSON inline** — `GOOGLE_SERVICE_ACCOUNT_JSON`, נוח ב‑CI.
3. **Access token מוכן** — `GOOGLE_ACCESS_TOKEN`, למשל מ‑`gcloud auth print-access-token`.
4. **API key** (Vertex AI express mode) — `GOOGLE_API_KEY`. נשלח ב‑header `x-goog-api-key`
   ולא ב‑query string, כדי שלא ידלוף ללוגים של פרוקסי. אם אף ריג'ן לא עבד,
   הכלי מנסה בנוסף את האנדפוינט הגלובלי `https://aiplatform.googleapis.com`.

---

## מה צריך שיהיה מוגדר בצד של Google

אם הבדיקה נכשלת, כמעט תמיד זה אחד מהשלושה:

1. **ה‑API לא מופעל בפרויקט:**
   ```bash
   gcloud services enable aiplatform.googleapis.com --project <PROJECT_ID>
   ```
2. **ל‑service account אין הרשאה.** התפקיד המינימלי לשימוש במודלים:
   ```bash
   gcloud projects add-iam-policy-binding <PROJECT_ID> \
     --member="serviceAccount:<SA>@<PROJECT_ID>.iam.gserviceaccount.com" \
     --role="roles/aiplatform.user"
   ```
3. **הריג'ן לא נתמך למה שביקשת.** `me-west1` (תל אביב) מריץ Vertex AI, אבל לא כל
   מודל ולא כל שירות זמינים בו — Agent Engine ו‑Agent Builder, למשל, זמינים בקבוצת
   ריג'נים מצומצמת יותר מזו של מודלי Gemini. אם `me-west1` מחזיר `404` על מודל מסוים
   בזמן ש‑`location` מחזיר `200`, המפתח תקין והבעיה היא זמינות המודל בריג'ן — נסה
   `--generate --model <מודל אחר>` או ריג'ן חלופי.

## טבלת שגיאות

| מה שרואים | הסיבה הרגילה |
|-----------|---------------|
| `401` בכל בדיקה | הטוקן פג או שהמפתח בוטל |
| `invalid_grant: account not found` | ה‑service account נמחק, או שהמפתח שייך לפרויקט אחר |
| `invalid_grant` עם מפתח תקין | שעון המכונה סוטה ביותר מכמה דקות — ה‑JWT נדחה |
| `403 ... has not been used in project` | ה‑API לא הופעל בפרויקט |
| `403 Permission denied` | חסר `roles/aiplatform.user` |
| `404` על `:generateContent` בלבד | המודל לא זמין בריג'ן הזה |
| `429` | חריגת מכסה — המפתח עצמו תקין |
| `HTML error page` | שם הריג'ן לא קיים |

## אבטחה

- `.gitignore` חוסם `.env`, `secrets/` וקבצי מפתח נפוצים.
- מפתחות מוצגים תמיד ממוסכים (`AIzaSy…cdef (39 chars)`).
- `Authorization` ו‑`x-goog-api-key` מוחלפים ב‑`***redacted***` גם ב‑`--verbose`.
- אם מפתח מופיע ב‑query string, הוא מוסתר לפני ההדפסה (`src/httpClient.js`, `fullUrl`).

מאחורי פרוקסי ארגוני: axios מכבד `HTTPS_PROXY`, ו‑Node מכבד `NODE_EXTRA_CA_CERTS`.

## מבנה

```
src/
  index.js        זרימה ראשית ופלט
  cli.js          פענוח דגלים וסדר הריג'נים
  credentials.js  זיהוי סוג המפתח וטעינתו, בלי לחשוף אותו
  auth.js         בניית JWT, חתימה, והחלפה בטוקן
  regions.js      רשימת הריג'נים וכל כתובות ה‑URL
  httpClient.js   מופע axios + interceptors שמדפיסים כל URL
  checks.js       הבדיקות לכל ריג'ן וסיווג התוצאה
  report.js       צבעים וטבלת סיכום
test/unit.test.js  11 בדיקות, בלי רשת
```

## בדיקות

```bash
npm test
```
