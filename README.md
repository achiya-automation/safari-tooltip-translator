# Mouse Tooltip Translator for Safari

תוסף סאפרי לתרגום סלקטיבי — מתרגם את מה שמצביעים עליו, קטעים בודדים בתוך העמוד, וכתוביות וידאו. לא מתרגם עמודים שלמים.

## מה הוא עושה

| יכולת | איך |
|---|---|
| תרגום בריחוף | מצביעים על טקסט → טולטיפ צף עם התרגום. שלושה מצבים: תמיד / רק עם Shift / כבוי (`⌥H`) |
| תרגום פסקה במקומה | `⌥ + לחיצה` על פסקה — התרגום נכנס מתחת למקור, בתוך העמוד. לחיצה שנייה מסירה |
| תרגום מה שגלוי במסך | `⌥A` — כל הקטעים הנראים מתורגמים בבקשת רשת אחת |
| מצב בחירה | `⌥S` — כל קטע מודגש בריחוף, לחיצה מתרגמת. `Esc` ליציאה |
| סימון טקסט | מציג כפתור "תרגם" צף ליד הסימון |
| תרגום שדה קלט | הקשה על `⌥` לבד מתרגמת את השדה שכותבים בו (עברית↔אנגלית) |
| כתוביות מתורגמות | `⌥K` — יוטיוב (דרך המנוע שלו), נגני `<track>`/HLS (תרגום מראש של כל השורות), נטפליקס/Meet/Teams/Zoom/Udemy (קריאת ה-DOM) |

## מה אי-אפשר (נבדק, לא הושמט בטעות)

תמלול קול של העמוד בסאפרי חסום: `captureStream` לא קיים ב-WebKit, ‏`createMediaElementSource` מחזיר שקט על מדיה cross-origin (נמדד: peak ‎0.00000 על יוטיוב), אין tabCapture, ו-SpeechRecognition מאזין רק למיקרופון. לכן הכתוביות מתרגמות כתוביות קיימות — לא ממציאות אותן מהקול.

## ארכיטקטורה

```
extension/
  background.js   שער התרגום היחיד: clients5 (batch, עמיד ל-429) עם gtx כגיבוי,
                  token-bucket + cooldown, פיצול לבקשות עד ~7000 תווים
  content.js      ליבה: איתור טקסט, טולטיפ, מקלדת, iframes, window.MTT
  blocks.js       תרגום קטעים במקום: איתור פסקאות, מצב בחירה, תרגום מסך
  captions.js     כתוביות: יוטיוב / TextTrack / DOM observers
  popup.html/js   פאנל פעולות והגדרות
```

## פיתוח

```bash
node test/run.mjs      # 30 בדיקות התנהגות ב-WebKit אמיתי (Playwright)
node test/live.mjs     # בדיקה על ויקיפדיה/BBC/HN/MDN/GitHub חיים
node test/captions.mjs # כתוביות בניגון חי
```

בנייה: פתיחת `xcode-project/Tooltip Translator` ב-Xcode → Build, או:

```bash
cd "xcode-project/Tooltip Translator" && xcodebuild -scheme "Tooltip Translator" -configuration Release build
```

## Privacy

הטקסט המתורגם נשלח ל-Google Translate (endpoint ציבורי). שום דבר אחר לא נאסף ולא נשמר.
