import { Check, KeyRound, PlugZap, Save } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import type { Settings } from "../types";

interface Props {
  settings: Settings;
  onSaved: (settings: Settings) => void;
  notify: (message: string) => void;
}

export function SettingsView({ settings, onSaved, notify }: Props) {
  const [form, setForm] = useState<Settings>({ ...settings, apiKey: "" });
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState(false);

  useEffect(() => setForm({ ...settings, apiKey: "" }), [settings]);

  const update = (key: keyof Settings, value: string | boolean) => {
    setTested(false);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const payload: Partial<Settings> = { ...form };
      if (!form.apiKey) delete payload.apiKey;
      const saved = await window.pet.saveSettings(payload);
      onSaved(saved);
      notify("设置已保存。");
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      await window.pet.testConnection(form);
      setTested(true);
      notify("模型接口连接正常。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="settings-page">
      <header className="settings-header">
        <h1>设置</h1>
        <span>{settings.hasApiKey ? "模型密钥已安全保存" : "尚未配置模型密钥"}</span>
      </header>
      <form className="settings-form" onSubmit={save}>
        <section>
          <h2>身份</h2>
          <label>
            <span>名字</span>
            <input value={form.petName} onChange={(event) => update("petName", event.target.value)} />
          </label>
          <label>
            <span>核心提示</span>
            <textarea rows={5} value={form.systemPrompt} onChange={(event) => update("systemPrompt", event.target.value)} />
          </label>
        </section>

        <section>
          <h2>模型</h2>
          <div className="form-grid">
            <label>
              <span>文本模型地址</span>
              <input value={form.chatBaseUrl} onChange={(event) => update("chatBaseUrl", event.target.value)} />
            </label>
            <label>
              <span>语音转写地址</span>
              <input value={form.transcriptionBaseUrl} onChange={(event) => update("transcriptionBaseUrl", event.target.value)} />
            </label>
          </div>
          <div className="form-grid">
            <label>
              <span>聊天模型</span>
              <input value={form.chatModel} onChange={(event) => update("chatModel", event.target.value)} />
            </label>
            <label>
              <span>转写模型</span>
              <input value={form.transcriptionModel} onChange={(event) => update("transcriptionModel", event.target.value)} />
            </label>
          </div>
          <label>
            <span><KeyRound size={15} /> API Key</span>
            <input
              type="password"
              value={form.apiKey || ""}
              placeholder={settings.hasApiKey ? "已保存，留空保持不变" : "输入密钥"}
              autoComplete="off"
              onChange={(event) => update("apiKey", event.target.value)}
            />
          </label>
          <div className="form-grid compact">
            <label>
              <span>Temperature</span>
              <input type="number" min="0" max="2" step="0.1" value={form.temperature} onChange={(event) => update("temperature", event.target.value)} />
            </label>
            <label className="check-field">
              <span>自动朗读回复</span>
              <input type="checkbox" checked={form.autoSpeak} onChange={(event) => update("autoSpeak", event.target.checked)} />
              <span className="toggle" aria-hidden="true" />
            </label>
          </div>
        </section>

        <div className="settings-actions">
          <button type="button" className="secondary-button" onClick={test} disabled={busy}>
            {tested ? <Check size={17} /> : <PlugZap size={17} />}
            {tested ? "连接正常" : "测试连接"}
          </button>
          <button type="submit" className="command-button" disabled={busy}>
            <Save size={17} />保存
          </button>
        </div>
      </form>
    </main>
  );
}
