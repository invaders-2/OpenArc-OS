const { app } = require("electron");
app.whenReady().then(() => {
  const out = {};
  try {
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(":memory:");
    out.node = process.versions.node;
    out.electron = process.versions.electron;
    out.sqlite = d.prepare("select sqlite_version() v").get().v;
    d.exec("CREATE VIRTUAL TABLE f USING fts5(body, tokenize='unicode61')");
    d.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram')");
    d.prepare("INSERT INTO t(body) VALUES (?)").run("详情页 生成提示词");
    out.trigram = JSON.stringify(d.prepare("SELECT body FROM t WHERE t MATCH ?").all("详情页"));
    d.exec("CREATE VIRTUAL TABLE s USING fts5(body)");
    d.prepare("INSERT INTO s(body) VALUES (?)").run("hello world");
    out.snippet = JSON.stringify(d.prepare("SELECT snippet(s,0,'[',']','…',5) x, bm25(s) r FROM s WHERE s MATCH ?").all("hello"));
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = String(e.message).slice(0, 200);
  }
  process.stdout.write("FTSRESULT " + JSON.stringify(out) + "\n");
  app.quit();
});
