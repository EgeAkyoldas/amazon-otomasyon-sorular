(function () {
  "use strict";

  var STORE_KEY = "onGorusme.v1";
  var QUEUE_KEY = "onGorusme.queue.v1";
  var SECTIONS = window.SECTIONS || [];
  var ENDPOINT = (window.APP_CONFIG && window.APP_CONFIG.endpoint) || "";

  // ---------- Saklama (tarayıcı) ----------

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* özel sekme ya da dolu depolama: sayfa yine çalışır */
    }
  }

  var state = load(STORE_KEY, null) || { person: "", device: "", key: "", answers: {}, done: false };
  if (!state.device) state.device = Math.random().toString(36).slice(2, 10);

  // Erişim anahtarı linkte gelir (?k=...), sonraki ziyaretler için saklanır.
  var urlKey = new URLSearchParams(location.search).get("k");
  if (urlKey) state.key = urlKey;
  store(STORE_KEY, state);

  var queue = load(QUEUE_KEY, []);

  // ---------- Kayıt katmanı ----------
  // Tüm yazma buradan geçer. Depo değişirse yalnızca send() değişir.

  var flushTimer = null;
  var retryTimer = null;
  var inFlight = null;

  function saveAnswer(question, section) {
    var a = state.answers[question.id] || {};
    store(STORE_KEY, state);
    // Aynı soru için bekleyen eski satırı at; son hali gönderilir.
    queue = queue.filter(function (r) { return r.id !== question.id; });
    queue.push({
      id: question.id,
      section: section.title,
      question: question.text,
      answer: formatValue(a.value),
      comment: a.comment || "",
      clientTime: new Date().toISOString(),
    });
    store(QUEUE_KEY, queue);
    updateProgress();
    scheduleFlush(1200);
  }

  function formatValue(v) {
    if (Array.isArray(v)) return v.join(" | ");
    return v == null ? "" : String(v);
  }

  function scheduleFlush(ms) {
    clearTimeout(flushTimer);
    setSave("Kaydediliyor…", "wait");
    flushTimer = setTimeout(flush, ms);
  }

  function send(payload) {
    // text/plain: tarayıcı ön kontrol isteği atmaz, Apps Script bunu kabul eder.
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("http " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || data.ok !== true) throw new Error((data && data.error) || "reddedildi");
        return data;
      });
  }

  function flush(event) {
    if (!ENDPOINT) {
      setSave("Bu cihazda saklandı", "ok");
      return Promise.resolve(false);
    }
    // Bir gönderim yoldaysa onun bitmesini bekle, sonra sıradakini gönder.
    if (inFlight) return inFlight.then(function () { return flush(event); });
    if (!queue.length && !event) {
      setSave("Kaydedildi", "ok");
      return Promise.resolve(true);
    }

    var batch = queue.slice();
    var payload = {
      key: state.key,
      person: state.person.trim() || "(isim yazılmadı)",
      device: state.device,
      rows: batch,
    };
    if (event) payload.event = event;

    inFlight = send(payload)
      .then(function () {
        inFlight = null;
        var sentAt = {};
        batch.forEach(function (r) { sentAt[r.id] = r.clientTime; });
        // Gönderim sırasında değişen cevaplar kuyrukta kalır.
        queue = queue.filter(function (r) { return sentAt[r.id] !== r.clientTime; });
        store(QUEUE_KEY, queue);
        if (queue.length) scheduleFlush(600);
        else setSave("Kaydedildi", "ok");
        return true;
      })
      .catch(function (err) {
        inFlight = null;
        if (String(err.message) === "key") {
          setSave("Bağlantı geçersiz. Size gönderilen linki kullanın.", "wait");
        } else {
          setSave("Bu cihazda saklandı, bağlantı gelince gönderilecek", "wait");
          clearTimeout(retryTimer);
          retryTimer = setTimeout(flush, 15000);
        }
        return false;
      });
    return inFlight;
  }

  window.addEventListener("online", function () { flush(); });

  // ---------- Arayüz ----------

  var saveEl = document.getElementById("save");
  var countEl = document.getElementById("count");
  var fillEl = document.getElementById("fill");

  function setSave(text, cls) {
    saveEl.textContent = text;
    saveEl.className = "save" + (cls ? " " + cls : "");
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (k === "class") node.className = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function isAnswered(q) {
    var a = state.answers[q.id];
    if (!a) return false;
    if (Array.isArray(a.value)) return a.value.length > 0 || !!a.comment;
    return (a.value != null && String(a.value).trim() !== "") || !!a.comment;
  }

  var allQuestions = [];
  SECTIONS.forEach(function (s) { s.questions.forEach(function (q) { allQuestions.push(q); }); });

  function updateProgress() {
    var n = allQuestions.filter(isAnswered).length;
    countEl.textContent = n + " / " + allQuestions.length + " cevaplandı";
    fillEl.style.width = (allQuestions.length ? (n / allQuestions.length) * 100 : 0) + "%";

    SECTIONS.forEach(function (section) {
      var tag = document.getElementById("n-" + section.id);
      if (!tag) return;
      var done = section.questions.filter(isAnswered).length;
      tag.textContent = done + " / " + section.questions.length;
      tag.className = "group-count" + (done === section.questions.length ? " full" : "");
    });
  }

  function setValue(q, section, value) {
    var a = state.answers[q.id] || (state.answers[q.id] = {});
    a.value = value;
    saveAnswer(q, section);
  }

  function setComment(q, section, text) {
    var a = state.answers[q.id] || (state.answers[q.id] = {});
    a.comment = text;
    saveAnswer(q, section);
  }

  function renderOptions(q, section) {
    var current = (state.answers[q.id] || {}).value;
    var multi = q.type === "multi";
    var box = el("fieldset", { class: "opts" }, [
      el("legend", { class: "q-kind", text: multi ? "Birden fazla seçebilirsiniz" : "Birini seçin" }),
    ]);

    q.options.forEach(function (label, i) {
      var input = el("input", {
        type: multi ? "checkbox" : "radio",
        name: q.id,
        value: label,
      });
      input.checked = multi ? Array.isArray(current) && current.indexOf(label) !== -1 : current === label;
      input.addEventListener("change", function () {
        if (multi) {
          var picked = [];
          box.querySelectorAll("input:checked").forEach(function (n) { picked.push(n.value); });
          setValue(q, section, picked);
        } else {
          setValue(q, section, label);
        }
      });
      var recommended = q.rec === i;
      box.appendChild(
        el("label", { class: "opt" + (recommended ? " opt-rec" : "") }, [
          input,
          el("span", { class: "opt-label", text: label }),
          recommended ? el("span", { class: "rec", text: "Önerimiz" }) : null,
          // Önerinin nedeni şıkkın içinde, tam genişlikte durur: rozet tek başına bir şey anlatmıyor.
          recommended && q.recWhy ? el("span", { class: "rec-why", text: "Neden öneriyoruz: " + q.recWhy }) : null,
        ])
      );
    });

    if (multi) return box;

    // Tek seçimli soruda yanlışlıkla verilen cevabı geri almanın yolu.
    var clear = el("button", { type: "button", class: "clear", text: "Seçimi kaldır" });
    clear.hidden = !current;
    clear.addEventListener("click", function () {
      box.querySelectorAll("input:checked").forEach(function (n) { n.checked = false; });
      clear.hidden = true;
      setValue(q, section, "");
    });
    box.addEventListener("change", function () { clear.hidden = false; });

    var frag = document.createDocumentFragment();
    frag.appendChild(box);
    frag.appendChild(clear);
    return frag;
  }

  function renderInput(q, section) {
    var current = (state.answers[q.id] || {}).value || "";
    var input;
    if (q.type === "long") {
      input = el("textarea", { class: "answer", id: "in-" + q.id, "aria-labelledby": "t-" + q.id });
    } else {
      input = el("input", {
        type: q.type === "number" ? "number" : "text",
        id: "in-" + q.id,
        "aria-labelledby": "t-" + q.id,
      });
      if (q.type === "number") {
        input.setAttribute("inputmode", "decimal");
        input.setAttribute("min", "0");
      }
    }
    if (q.placeholder) input.setAttribute("placeholder", q.placeholder);
    else if (q.type === "number") input.setAttribute("placeholder", "Yaklaşık bir rakam yeter");
    input.value = current;
    input.addEventListener("input", function () { setValue(q, section, input.value); });

    if (q.unit) {
      return el("div", { class: "with-unit" }, [el("span", { class: "unit", text: q.unit }), input]);
    }
    return input;
  }

  function renderComment(q, section) {
    var existing = (state.answers[q.id] || {}).comment || "";
    var area = el("textarea", { id: "c-" + q.id });
    area.value = existing;
    area.addEventListener("input", function () { setComment(q, section, area.value); });

    var panel = el("div", { class: "comment" }, [
      el("label", { for: "c-" + q.id, text: "Yorumunuz" }),
      area,
    ]);
    panel.hidden = !existing;

    var toggle = el("button", {
      type: "button",
      class: "comment-toggle",
      "aria-expanded": existing ? "true" : "false",
      text: existing ? "Yorumu gizle" : "Yorum ekle",
    });
    toggle.addEventListener("click", function () {
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
      toggle.textContent = panel.hidden ? (area.value ? "Yorumu göster" : "Yorum ekle") : "Yorumu gizle";
      if (!panel.hidden) area.focus();
    });

    var frag = document.createDocumentFragment();
    frag.appendChild(toggle);
    frag.appendChild(panel);
    return frag;
  }

  function renderForm() {
    var root = document.getElementById("form");
    SECTIONS.forEach(function (section) {
      var group = el("div", { class: "group", id: "g-" + section.id }, [
        el("div", { class: "group-head" }, [
          el("h3", { text: section.title }),
          el("span", { class: "group-count", id: "n-" + section.id }),
        ]),
        section.intro ? el("p", { class: "group-intro", text: section.intro }) : null,
      ]);

      section.questions.forEach(function (q) {
        var isChoice = q.type === "single" || q.type === "multi";
        var block = el("div", { class: "q" }, [
          el("p", { class: "q-text", id: "t-" + q.id, text: q.text }),
          q.why ? el("p", { class: "q-why", text: q.why }) : null,
          isChoice ? renderOptions(q, section) : renderInput(q, section),
        ]);
        // Serbest metin sorularında cevabın kendisi yorumdur; ayrı alan gereksiz.
        if (q.type !== "long") block.appendChild(renderComment(q, section));
        var others = el("div", { class: "others", id: "o-" + q.id });
        others.hidden = true;
        block.appendChild(others);
        group.appendChild(block);
      });

      root.appendChild(group);
    });
  }

  // ---------- Ekipten gelen cevaplar ----------
  // Başka cihazlardan verilen cevaplar, kimin verdiğiyle birlikte sorunun altında listelenir.

  function renderOthers(rows) {
    var byQuestion = {};
    rows.forEach(function (r) {
      if (!r || r.device === state.device) return;
      if (!r.answer && !r.comment) return;
      (byQuestion[r.id] || (byQuestion[r.id] = [])).push(r);
    });

    allQuestions.forEach(function (q) {
      var box = document.getElementById("o-" + q.id);
      if (!box) return;
      var list = byQuestion[q.id] || [];
      box.textContent = "";
      box.hidden = !list.length;
      if (!list.length) return;

      box.appendChild(el("p", { class: "others-title", text: "Ekipten gelen cevaplar" }));
      list.forEach(function (r) {
        var answer = String(r.answer || "").split(" | ").join(", ");
        box.appendChild(
          el("div", { class: "other" }, [
            el("span", { class: "other-name", text: String(r.person || "İsimsiz") }),
            answer ? el("span", { class: "other-answer", text: answer }) : null,
            r.comment ? el("span", { class: "other-comment", text: String(r.comment) }) : null,
          ])
        );
      });
    });
  }

  function loadOthers() {
    if (!ENDPOINT || !state.key) return;
    fetch(ENDPOINT + "?k=" + encodeURIComponent(state.key))
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && Array.isArray(data.rows)) renderOthers(data.rows);
      })
      .catch(function () {
        /* okunamazsa form yine çalışır; bir sonraki denemede gelir */
      });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") loadOthers();
  });
  setInterval(function () {
    if (document.visibilityState === "visible") loadOthers();
  }, 45000);

  // ---------- İsim ----------

  // Sorular isim yazılınca açılır: cevaplar baştan doğru kişiye yazılsın.

  var personEl = document.getElementById("person");
  var personHint = document.getElementById("person-hint");
  var formEl = document.getElementById("form");
  var finishEl = document.getElementById("finish");
  var lockNote = document.getElementById("lock-note");
  var PERSON_HINT = "Cevapların kime ait olduğunu bilmemiz için. Her biriniz kendi telefonundan ayrı ayrı doldurabilir.";

  function applyLock() {
    var locked = state.person.trim().length < 2;
    formEl.inert = locked;
    finishEl.inert = locked;
    formEl.classList.toggle("locked", locked);
    finishEl.classList.toggle("locked", locked);
    lockNote.hidden = !locked;
  }

  personEl.value = state.person || "";
  personEl.addEventListener("input", function () {
    state.person = personEl.value;
    store(STORE_KEY, state);
    personHint.textContent = PERSON_HINT;
    personHint.className = "field-hint";
    applyLock();
  });

  // ---------- Tamamla ----------

  var doneBtn = document.getElementById("done-btn");
  var doneState = document.getElementById("done-state");

  function showDone() {
    doneState.textContent = "Teşekkürler, cevaplarınız ulaştı. İnceleyip size döneceğiz. İsterseniz cevaplarınızı değiştirmeye devam edebilirsiniz.";
    doneBtn.textContent = "Tekrar bildir";
  }

  doneBtn.addEventListener("click", function () {
    if (!state.person.trim()) {
      personHint.textContent = "Lütfen önce adınızı yazın.";
      personHint.className = "field-hint warn";
      personEl.focus();
      return;
    }
    if (!ENDPOINT) {
      doneState.textContent = "Cevaplarınız bu cihazda saklandı. Gönderim adresi henüz ayarlanmadı.";
      return;
    }

    // Tamamlarken tüm cevapları baştan gönder: arada kaybolan satır kalmasın.
    queue = [];
    SECTIONS.forEach(function (section) {
      section.questions.forEach(function (q) {
        if (!isAnswered(q)) return;
        var a = state.answers[q.id];
        queue.push({
          id: q.id,
          section: section.title,
          question: q.text,
          answer: formatValue(a.value),
          comment: a.comment || "",
          clientTime: new Date().toISOString(),
        });
      });
    });
    store(QUEUE_KEY, queue);

    doneBtn.disabled = true;
    doneState.textContent = "Gönderiliyor…";
    clearTimeout(flushTimer);
    flush("done").then(function (ok) {
      doneBtn.disabled = false;
      if (ok) {
        state.done = true;
        store(STORE_KEY, state);
        showDone();
      } else {
        doneState.textContent = "Şu an gönderilemedi. Cevaplarınız bu cihazda duruyor; bağlantınızı kontrol edip tekrar deneyin.";
      }
    });
  });

  // ---------- Tema ----------

  var themeBtn = document.getElementById("theme-btn");

  function currentTheme() {
    var chosen = document.documentElement.getAttribute("data-theme");
    if (chosen) return chosen;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function paintThemeBtn() {
    themeBtn.textContent = currentTheme() === "dark" ? "Açık tema" : "Koyu tema";
  }

  themeBtn.addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("onGorusme.theme", next); } catch (e) {}
    paintThemeBtn();
  });

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintThemeBtn);
  }
  paintThemeBtn();

  // ---------- Başlat ----------

  renderForm();
  applyLock();
  updateProgress();
  loadOthers();
  if (state.done) showDone();

  if (!allQuestions.some(isAnswered)) setSave("Henüz cevap yok");
  else if (queue.length) flush();
  else setSave(ENDPOINT ? "Kaydedildi" : "Bu cihazda saklandı", "ok");
})();
