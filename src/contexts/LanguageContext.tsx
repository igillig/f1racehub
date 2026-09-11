"use client";

import React, { createContext, useContext, useState, useEffect } from "react";

type Language = "es" | "en";

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(
  undefined,
);

const translations = {
  es: {
    // TopBar
    "beta.tooltip": "App en desarrollo. Si experimentás demoras o desconexiones, refrescá en unos segundos.",
    "topbar.laps": "Vuelta",
    "topbar.of": "de",

    // TimingBoard
    "timing.driver": "Piloto",
    "timing.pit": "PIT",
    "timing.tire": "Neumático",
    "timing.position": "+/-",
    "timing.gap": "Diferencia",
    "timing.interval": "Intervalo",
    "timing.gapToggleTooltip": "Mostrar intervalo al de adelante como valor principal",
    "timing.intervalToggleTooltip": "Mostrar diferencia al líder como valor principal",
    "timing.last": "Última",
    "timing.s1": "S1",
    "timing.s2": "S2",
    "timing.s3": "S3",
    "timing.waiting": "Esperando datos de pilotos...",
    "timing.lastLap": "Últ. Vuelta",
    "timing.waitingData": "Esperando datos...",
    "driver.lastLap": "Última Vuelta",

    // DriverRow
    "driver.inPit": "En boxes",
    "driver.pitOut": "Vuelta de salida",
    "driver.retired": "Retirado",
    "driver.drsEnabled": "DRS disponible",
    "driver.drsDisabled": "DRS no disponible",
    "driver.drsActive": "DRS activo",
    "driver.drsInactive": "DRS inactivo",
    "driver.tireAge": "Edad del neumático",
    "driver.laps": "vueltas",
    "driver.lapsOld": "{{laps}} vueltas de uso",
    "driver.newTire": "Nuevo",
    "driver.bestLap": "Mejor vuelta personal",
    "driver.lastLapBest": "Última vuelta (¡Mejor personal!)",
    "driver.sessionFastest": "¡Vuelta más rápida de la sesión!",
    "driver.positionGain": "posiciones ganadas",
    "driver.positionLoss": "posiciones perdidas",
    "driver.gapToLeader": "Diferencia al líder",
    "driver.intervalToAhead": "Intervalo al de adelante",
    "driver.bestLapTime": "Mejor tiempo de vuelta",
    "driver.bestSectorTime": "Mejor tiempo de sector",
    "driver.miniSectorRecord": "Récord de mini sector",
    "driver.miniSectorBest": "Mejor mini sector personal",
    "driver.miniSectorSlower": "Más lento que el mejor",
    "driver.miniSectorPit": "Mini sector en pit",
    "driver.miniSectorNoData": "Sin datos",
    "driver.sectorBest": "Mejor sector general",
    "driver.sectorPersonalBest": "Mejor sector personal",
    "driver.sectorSlower": "Más lento que mejor personal",
    "driver.sectorCurrent": "Tiempo de sector actual",
    "driver.soft": "Blando",
    "driver.medium": "Medio",
    "driver.hard": "Duro",
    "driver.intermediate": "Intermedio",
    "driver.wet": "Lluvia",

    // RaceControl
    "raceControl.title": "Control de Carrera",
    "raceControl.lap": "Vuelta {{lap}}",
    "raceControl.noMessages": "No hay mensajes",

    // RaceControl - Categories (from API)
    "raceControl.category.Flag": "Bandera",
    "raceControl.category.SafetyCar": "Safety Car",
    "raceControl.category.CarEvent": "Evento de Auto",
    "raceControl.category.Drs": "DRS",
    "raceControl.category.TrackLimits": "Límites de Pista",
    "raceControl.category.Other": "Otro",

    // RaceControl - Flag messages (translate common patterns)
    "raceControl.flag.green": "BANDERA VERDE",
    "raceControl.flag.yellow": "BANDERA AMARILLA",
    "raceControl.flag.doubleYellow": "DOBLE BANDERA AMARILLA",
    "raceControl.flag.red": "BANDERA ROJA",
    "raceControl.flag.blue": "BANDERA AZUL",
    "raceControl.flag.chequered": "BANDERA A CUADROS",
    "raceControl.flag.blackWhite": "BANDERA BLANCA Y NEGRA",
    "raceControl.flag.black": "BANDERA NEGRA",

    // RaceControl - Common message patterns
    "raceControl.msg.trackLimits": "LÍMITES DE PISTA",
    "raceControl.msg.safetyCarDeployed": "SAFETY CAR DESPLEGADO",
    "raceControl.msg.safetyCarEnding": "SAFETY CAR FINALIZANDO",
    "raceControl.msg.vscDeployed": "VSC DESPLEGADO",
    "raceControl.msg.vscEnding": "VSC FINALIZANDO",
    "raceControl.msg.drsEnabled": "DRS HABILITADO",
    "raceControl.msg.drsDisabled": "DRS DESHABILITADO",
    "raceControl.msg.cleared": "DESPEJADO",
    "raceControl.msg.clear": "DESPEJADO",
    "raceControl.msg.allClear": "TODO DESPEJADO",

    // TeamRadios
    "teamRadios.title": "Radio de Equipos",
    "teamRadios.noRadios": "No hay comunicaciones",

    // TrackViolations
    "violations.title": "Violaciones de Pista",
    "violations.noViolations": "No hay violaciones",
    "violations.violation": "Violación",
    "violations.violations": "Violaciones",
    "violations.deleted": "Tiempo eliminado",
    "violations.deletedPlural": "Tiempos eliminados",

    // TrackMap
    "map.loading": "Cargando mapa...",
    "map.error": "Error al cargar el mapa",
    "map.notAvailable": "Mapa no disponible",
    "map.gpsFallback": "Posiciones aproximadas — GPS en vivo no disponible",
    "map.generatedOutline": "Mapa no disponible - Trazado recreado a partir del GPS",
    "map.generatedOutlineHint":
      "El plano oficial de este circuito no está disponible. El trazado se reconstruyó con una vuelta real y puede tener imprecisiones.",

    // Footer
    "footer.madeWith": "Hecho con",
    "footer.support": "Apoyar",
    "footer.version": "Versión",
    "support.title": "Apoyá el proyecto",
    "support.desc": "Si te gusta F1 RaceHub, podés ayudarme a cubrir los costos del servidor y las APIs de las que consumimos los datos.",
    "support.close": "Cerrar",
    "footer.contact": "Contacto",
    "contact.title": "Contacto",
    "contact.desc": "¿Encontraste un error, tenés una idea o querés decir algo? Escribime.",
    "contact.name": "Tu nombre",
    "contact.email": "Tu email",
    "contact.message": "Mensaje",
    "contact.send": "Enviar",
    "contact.sending": "Enviando…",
    "contact.sent": "¡Mensaje enviado! Te respondo a la brevedad.",
    "contact.errorInvalid": "Revisá los campos: el mensaje debe tener al menos 10 caracteres y el email ser válido.",
    "contact.errorRateLimited": "Demasiados mensajes seguidos. Probá de nuevo en un rato.",
    "contact.errorGeneric": "No se pudo enviar el mensaje. Intentá más tarde.",
    "footer.disclaimer":
      "Este sitio no está afiliado, asociado, autorizado, respaldado por, o de ninguna manera oficialmente conectado con Formula 1, FIA, o cualquiera de sus subsidiarias o afiliados.",

    // Error messages
    "error.offline": "Sistema temporalmente fuera de servicio",
    "error.retrying":
      "Cuando el servicio esté operativo serás redirigido automáticamente",
    "error.offlineBadge": "Fuera de línea",
    "error.connection": "Cargando telemetría de demo...",
    "error.reconnecting": "Reconectando...",
    "mode.replayLabel": "Modo Demo:",
    "mode.replayDesc":
      "No hay sesión en vivo. Mostrando sesión grabada — cuando comience una, verás telemetría real.",
    "mode.standbyLabel": "Esperando sesión en vivo",
    "mode.standbyDesc":
      "El proxy se conectará automáticamente cuando inicie la sesión.",
    "mode.signalrDegradedLabel": "Datos en vivo degradados:",
    "mode.signalrDegradedDesc":
      "Hay inconvenientes con el proveedor de cronometraje oficial. Algunos datos (mini-sectores, tiempo restante, eliminados) pueden llegar con delay o faltar.",

    // Track status
    "status.allClear": "Despejado",
    "status.yellow": "Bandera Amarilla",
    "status.green": "Bandera Verde",
    "status.scDeployed": "Safety Car",
    "status.red": "Bandera Roja",
    "status.vscDeployed": "Virtual Safety Car",
    "status.vscEnding": "VSC Finalizando",
    "status.chequered": "Bandera a Cuadros",

    // Session types
    "session.title": "Sesión",
    "session.remaining": "Restante",
    "session.lap": "Vuelta",
    "session.type": "Tipo",
    "session.race": "Carrera",
    "session.qualifying": "Clasificación",
    "session.practice": "Práctica",
    "session.sprintQualifying": "Sprint Qualifying",
    "session.sprint": "Sprint",
    "session.noActive": "No hay sesión activa",

    // Weather
    "weather.trackTemp": "Temperatura de Pista",
    "weather.airTemp": "Temperatura del Aire",
    "weather.humidity": "Humedad",
    "weather.rain": "Lluvia detectada",
    "weather.dry": "Condiciones secas",
    "weather.wind": "Viento",

    // Dashboard tabs
    "tab.map": "Mapa",
    "tab.control": "Control",
    "tab.limits": "Límites",
    "tab.radio": "Radio",

    // Alert strip labels
    "alert.raceControl": "Control de Carrera",
    "alert.violations": "Violaciones",
    "alert.radio": "Radio",

    // Drawer nav
    "drawer.stats": "Estadísticas",
    "drawer.standings": "Campeonato",
    "drawer.comparisons": "Comparativas",
    "drawer.login": "Iniciar sesión",
    "drawer.soon": "Pronto",
    "drawer.language": "Idioma",

    // Standings / Championship
    "standings.title": "Campeonato Mundial",
    "standings.drivers": "Pilotos",
    "standings.teams": "Constructores",
    "standings.updatedAfter": "Actualizado tras",
    "standings.unavailable": "Clasificación no disponible",
    "standings.source": "Datos: OpenF1",

    // Viewers
    "viewers.watching": "Viendo ahora",
    "viewers.count": "{{count}} espectadores",

    // Landing page
    "landing.nextRace": "Próxima Carrera",
    "landing.startsIn": "Comienza En",
    "landing.liveNow": "En Curso",
    "landing.weekendSchedule": "Este Fin de Semana",
    "landing.enterDemo": "Entrar al Modo Demo",
    "landing.replayInfo":
      "Reproduciendo: Azerbaijan GP 2024 · Baku City Circuit",
    "landing.scheduleUnavailable": "Calendario no disponible",
    "landing.countdown.days": "Días",
    "landing.countdown.hours": "Horas",
    "landing.countdown.minutes": "Min",
    "landing.countdown.seconds": "Seg",
    "landing.waitingSignal": "Esperando datos de sesión en vivo",
    "landing.sessionAboutToStart":
      "Se conectará automáticamente cuando comience la sesión",
  },
  en: {
    // TopBar
    "beta.tooltip": "App under development. If you experience delays or disconnections, refresh in a few seconds.",
    "topbar.laps": "Lap",
    "topbar.of": "of",

    // TimingBoard
    "timing.driver": "Driver",
    "timing.pit": "PIT",
    "timing.tire": "Tire",
    "timing.position": "+/-",
    "timing.gap": "Gap",
    "timing.interval": "Interval",
    "timing.gapToggleTooltip": "Show interval to car ahead as primary value",
    "timing.intervalToggleTooltip": "Show gap to leader as primary value",
    "timing.last": "Last",
    "timing.s1": "S1",
    "timing.s2": "S2",
    "timing.s3": "S3",
    "timing.waiting": "Waiting for driver data...",
    "timing.lastLap": "Last Lap",
    "timing.waitingData": "Waiting for data...",
    "driver.lastLap": "Last Lap",

    // DriverRow
    "driver.inPit": "In pit",
    "driver.pitOut": "Pit out lap",
    "driver.retired": "Retired",
    "driver.drsEnabled": "DRS available",
    "driver.drsDisabled": "DRS not available",
    "driver.drsActive": "DRS active",
    "driver.drsInactive": "DRS inactive",
    "driver.tireAge": "Tire age",
    "driver.laps": "laps",
    "driver.lapsOld": "{{laps}} laps old",
    "driver.newTire": "New",
    "driver.bestLap": "Personal best lap",
    "driver.lastLapBest": "Last lap (Personal best!)",
    "driver.sessionFastest": "Session fastest lap!",
    "driver.positionGain": "positions gained",
    "driver.positionLoss": "positions lost",
    "driver.gapToLeader": "Gap to leader",
    "driver.intervalToAhead": "Interval to car ahead",
    "driver.bestLapTime": "Best lap time",
    "driver.bestSectorTime": "Best sector time",
    "driver.miniSectorRecord": "Mini sector record",
    "driver.miniSectorBest": "Personal best mini sector",
    "driver.miniSectorSlower": "Slower than best",
    "driver.miniSectorPit": "Pit lane mini sector",
    "driver.miniSectorNoData": "No data",
    "driver.sectorBest": "Overall best sector",
    "driver.sectorPersonalBest": "Personal best sector",
    "driver.sectorSlower": "Slower than personal best",
    "driver.sectorCurrent": "Current sector time",
    "driver.soft": "Soft",
    "driver.medium": "Medium",
    "driver.hard": "Hard",
    "driver.intermediate": "Intermediate",
    "driver.wet": "Wet",
    // RaceControl
    "raceControl.title": "Race Control",
    "raceControl.lap": "Lap {{lap}}",
    "raceControl.noMessages": "No messages",

    // RaceControl - Categories (from API)
    "raceControl.category.Flag": "Flag",
    "raceControl.category.SafetyCar": "Safety Car",
    "raceControl.category.CarEvent": "Car Event",
    "raceControl.category.Drs": "DRS",
    "raceControl.category.TrackLimits": "Track Limits",
    "raceControl.category.Other": "Other",

    // RaceControl - Flag messages (keep in English as standard)
    "raceControl.flag.green": "GREEN FLAG",
    "raceControl.flag.yellow": "YELLOW FLAG",
    "raceControl.flag.doubleYellow": "DOUBLE YELLOW FLAG",
    "raceControl.flag.red": "RED FLAG",
    "raceControl.flag.blue": "BLUE FLAG",
    "raceControl.flag.chequered": "CHEQUERED FLAG",
    "raceControl.flag.blackWhite": "BLACK AND WHITE FLAG",
    "raceControl.flag.black": "BLACK FLAG",

    // RaceControl - Common message patterns
    "raceControl.msg.trackLimits": "TRACK LIMITS",
    "raceControl.msg.safetyCarDeployed": "SAFETY CAR DEPLOYED",
    "raceControl.msg.safetyCarEnding": "SAFETY CAR ENDING",
    "raceControl.msg.vscDeployed": "VSC DEPLOYED",
    "raceControl.msg.vscEnding": "VSC ENDING",
    "raceControl.msg.drsEnabled": "DRS ENABLED",
    "raceControl.msg.drsDisabled": "DRS DISABLED",
    "raceControl.msg.cleared": "CLEARED",
    "raceControl.msg.clear": "CLEAR",
    "raceControl.msg.allClear": "ALL CLEAR",

    // TeamRadios
    "teamRadios.title": "Team Radios",
    "teamRadios.noRadios": "No communications",

    // TrackViolations
    "violations.title": "Track Violations",
    "violations.noViolations": "No violations",
    "violations.violation": "Violation",
    "violations.violations": "Violations",
    "violations.deleted": "Time deleted",
    "violations.deletedPlural": "Times deleted",

    // TrackMap
    "map.loading": "Loading map...",
    "map.error": "Error loading map",
    "map.notAvailable": "Map not available",
    "map.gpsFallback": "Estimated positions — live GPS unavailable",
    "map.generatedOutline": "Track outline rebuilt from GPS",
    "map.generatedOutlineHint":
      "The official layout for this circuit is not available. The outline was reconstructed from a real lap and may be imprecise.",

    // Footer
    "footer.madeWith": "Made with",
    "footer.support": "Support",
    "support.title": "Support the project",
    "support.desc": "If you enjoy F1 RaceHub, you can help me cover the server and API costs that keep this running.",
    "support.close": "Close",
    "footer.contact": "Contact",
    "contact.title": "Contact",
    "contact.desc": "Found a bug, have an idea or just want to say hi? Drop me a line.",
    "contact.name": "Your name",
    "contact.email": "Your email",
    "contact.message": "Message",
    "contact.send": "Send",
    "contact.sending": "Sending…",
    "contact.sent": "Message sent! I'll get back to you soon.",
    "contact.errorInvalid": "Check the fields: the message needs at least 10 characters and a valid email.",
    "contact.errorRateLimited": "Too many messages in a row. Try again in a while.",
    "contact.errorGeneric": "Couldn't send the message. Please try again later.",
    "footer.version": "Version",
    "footer.disclaimer":
      "This site is not affiliated, associated, authorized, endorsed by, or in any way officially connected with Formula 1, FIA, or any of its subsidiaries or affiliates.",

    // Error messages
    "error.offline": "System temporarily unavailable",
    "error.retrying":
      "You will be redirected automatically when the service is back online",
    "error.offlineBadge": "Offline",
    "error.connection": "Loading demo telemetry...",
    "error.reconnecting": "Reconnecting...",
    "mode.replayLabel": "Demo Mode:",
    "mode.replayDesc": "No live session. Displaying recorded session — when one starts, you'll see real telemetry.",
    "mode.standbyLabel": "Waiting for live session",
    "mode.standbyDesc": "Will connect automatically when the session starts.",
    "mode.signalrDegradedLabel": "Live data degraded:",
    "mode.signalrDegradedDesc":
      "There are issues with the official timing provider. Some data (mini-sectors, remaining time, eliminations) may be delayed or missing.",

    // Track status
    "status.allClear": "All Clear",
    "status.yellow": "Yellow Flag",
    "status.green": "Green Flag",
    "status.scDeployed": "Safety Car Deployed",
    "status.red": "Red Flag",
    "status.vscDeployed": "VSC Deployed",
    "status.vscEnding": "VSC Ending",
    "status.chequered": "Chequered Flag",

    // Session types
    "session.title": "Session",
    "session.remaining": "Remaining",
    "session.lap": "Lap",
    "session.type": "Type",
    "session.race": "Race",
    "session.qualifying": "Qualifying",
    "session.practice": "Practice",
    "session.sprintQualifying": "Sprint Qualifying",
    "session.sprint": "Sprint",
    "session.noActive": "No Active Session",

    // Weather
    "weather.trackTemp": "Track Temperature",
    "weather.airTemp": "Air Temperature",
    "weather.humidity": "Humidity",
    "weather.rain": "Rain detected",
    "weather.dry": "Dry conditions",
    "weather.wind": "Wind",

    // Dashboard tabs
    "tab.map": "Map",
    "tab.control": "Control",
    "tab.limits": "Limits",
    "tab.radio": "Radio",

    // Alert strip labels
    "alert.raceControl": "Race Control",
    "alert.violations": "Violations",
    "alert.radio": "Radio",

    // Drawer nav
    "drawer.stats": "Statistics",
    "drawer.standings": "Standings",
    "drawer.comparisons": "Comparisons",
    "drawer.login": "Log in",
    "drawer.soon": "Soon",
    "drawer.language": "Language",

    // Standings / Championship
    "standings.title": "World Championship",
    "standings.drivers": "Drivers",
    "standings.teams": "Constructors",
    "standings.updatedAfter": "Updated after",
    "standings.unavailable": "Standings unavailable",
    "standings.source": "Data: OpenF1",

    // Viewers
    "viewers.watching": "Watching now",
    "viewers.count": "{{count}} viewers",

    // Landing page
    "landing.nextRace": "Next Race",
    "landing.startsIn": "Starts In",
    "landing.liveNow": "Live Now",
    "landing.weekendSchedule": "Weekend Schedule",
    "landing.enterDemo": "Enter Demo Mode",
    "landing.replayInfo": "Replaying: Azerbaijan GP 2024 · Baku City Circuit",
    "landing.scheduleUnavailable": "Schedule unavailable",
    "landing.countdown.days": "Days",
    "landing.countdown.hours": "Hours",
    "landing.countdown.minutes": "Min",
    "landing.countdown.seconds": "Sec",
    "landing.waitingSignal": "Waiting for live session data",
    "landing.sessionAboutToStart":
      "Will connect automatically when the session begins",
  },
};

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("es");

  useEffect(() => {
    const saved = localStorage.getItem("f1-dashboard-language") as Language;
    if (saved && (saved === "es" || saved === "en")) {
      setLanguageState(saved);
    }
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem("f1-dashboard-language", lang);
  };
  const t = (key: string, params?: Record<string, string | number>): string => {
    const dict = translations[language] as Record<string, string>;
    let text = dict[key] || key;

    // Replace {{param}} placeholders with values
    if (params) {
      Object.entries(params).forEach(([param, value]) => {
        text = text.replace(new RegExp(`{{${param}}}`, "g"), String(value));
      });
    }

    return text;
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}
