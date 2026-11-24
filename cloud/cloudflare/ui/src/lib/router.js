import { useCallback, useEffect, useState } from "react";
import { ROUTES, siteTestFailure } from "./meta.js";
import { scrollToTop } from "../components/motion.jsx";

// Menüde görünmeyen ama bağlantıyla açılan sayfalar: #/baglan/<site> (uyarı e-postasındaki yeniden bağlanma linki).
const HIDDEN = ["baglan"];
const valid = new Set([...ROUTES.map((r) => r.id), ...HIDDEN]);
const parts = () => window.location.hash.replace(/^#\/?/, "").split("?")[0].split("/");
const read = () => {
  const id = parts()[0];
  return valid.has(id) ? id : "bugun";
};
const readParam = () => {
  const [route, param] = parts();
  if (!valid.has(route) || !param) return "";
  try { return decodeURIComponent(param); } catch { return ""; }
};

/** Hash tabanlı yönlendirme: tarayıcının geri/ileri tuşu ve yer imleri çalışır. */
export function useHashRoute(sites = []) {
  const [route, setRoute] = useState(read);
  const [param, setParam] = useState(readParam);
  useEffect(() => {
    const onChange = () => {
      setRoute(read());
      setParam(readParam());
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const site = route === "baglan" && sites.find(entry => entry.id === param);
  const recovered = site && site.login === "ok" && site.error !== "auth" && siteTestFailure(site) !== "auth"
    && Boolean(site.lastSuccess || site.lastSessionCheck || site.lastTest?.ok);
  useEffect(() => {
    if (!recovered || read() !== "baglan" || readParam() !== param) return;
    window.history.replaceState(window.history.state, "", "#/bugun");
    setRoute("bugun");
    setParam("");
  }, [recovered, param]);
  const navigate = useCallback((id) => {
    if (id === read()) {
      scrollToTop(true);
      return;
    }
    window.location.hash = `/${id}`; // en üste dönüş, perde ekranı kaplayınca App içinde yapılır
  }, []);
  return [recovered ? "bugun" : route, navigate, param];
}
