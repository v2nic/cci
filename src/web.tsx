import { renderToStaticMarkup } from 'react-dom/server';

function buildClientScript(port: number): string {
  return [
    '      const { useEffect, useMemo, useRef, useState } = React;',
    '      const { createRoot } = ReactDOM;',
    '',
    '      function App() {',
    '        const [query, setQuery] = useState("");',
    '        const [projects, setProjects] = useState([]);',
    '        const [selectedTargets, setSelectedTargets] = useState([]);',
    '        const [events, setEvents] = useState([]);',
    '        const socketRef = useRef(null);',
    '',
    '        const selectedTargetSet = useMemo(() => new Set(selectedTargets), [selectedTargets]);',
    '',
    '        useEffect(() => {',
    '          let cancelled = false;',
    '          async function loadProjects() {',
    '            const response = await fetch("/api/projects?q=" + encodeURIComponent(query));',
    '            const payload = await response.json();',
    '            if (!cancelled) {',
    '              setProjects(payload.items);',
    '            }',
    '          }',
    '          loadProjects().catch((error) => console.error(error));',
    '          return () => { cancelled = true; };',
    '        }, [query]);',
    '',
    '        useEffect(() => {',
    '          return () => {',
    '            if (socketRef.current) {',
    '              socketRef.current.close();',
    '            }',
    '          };',
    '        }, []);',
    '',
    '        function ensureSocket() {',
    '          if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {',
    '            return socketRef.current;',
    '          }',
    '',
    '          const socket = new WebSocket("ws://" + location.host + "/ws");',
    '          socket.addEventListener("message", (incoming) => {',
    '            const message = JSON.parse(incoming.data);',
    '            if (message.type === "event" || message.type === "system") {',
    '              setEvents((current) => [message.payload, ...current]);',
    '            }',
    '          });',
    '          socketRef.current = socket;',
    '          return socket;',
    '        }',
    '',
    '        function toggleTarget(target) {',
    '          setSelectedTargets((current) =>',
    '            current.includes(target)',
    '              ? current.filter((value) => value !== target)',
    '              : [...current, target],',
    '          );',
    '        }',
    '',
    '        function subscribe() {',
    '          const socket = ensureSocket();',
    '          const payload = JSON.stringify({ type: "subscribe", targets: selectedTargets });',
    '          if (socket.readyState === WebSocket.OPEN) {',
    '            socket.send(payload);',
    '          } else {',
    '            socket.addEventListener("open", () => socket.send(payload), { once: true });',
    '          }',
    '        }',
    '',
    '        function renderEventRow(event) {',
    '          const isSystemEvent = event.kind === "subscribed";',
    '          return React.createElement(',
    '            "tr",',
    '            { key: event.id },',
    '            React.createElement("td", null, event.timestamp),',
    '            React.createElement("td", null, isSystemEvent ? event.targets.join(", ") : event.project),',
    '            React.createElement(',
    '              "td",',
    '              null,',
    '              isSystemEvent ? "-" : String(event.pipelineNumber),',
    '            ),',
    '            React.createElement("td", null, isSystemEvent ? event.kind : event.icon + " " + event.eventType),',
    '            React.createElement("td", null, isSystemEvent ? event.message : event.description),',
    '            React.createElement(',
    '              "td",',
    '              null,',
    '              isSystemEvent',
    '                ? "-"',
    '                : React.createElement(',
    '                    "a",',
    '                    { href: event.circleCiUrl, target: "_blank", rel: "noreferrer" },',
    '                    "Open",',
    '                  ),',
    '            ),',
    '          );',
    '        }',
    '',
    '        return React.createElement(',
    '          "div",',
    '          { className: "layout" },',
    '          React.createElement(',
    '            "section",',
    '            { className: "card sidebar" },',
    '            React.createElement("h1", null, "cci"),',
    `            React.createElement("p", { className: "hint" }, "Local daemon port: ${port}"),`,
    '            React.createElement("input", {',
    '              placeholder: "Search projects",',
    '              value: query,',
    '              onChange: (event) => setQuery(event.target.value),',
    '            }),',
    '            React.createElement("button", { onClick: subscribe }, "Subscribe"),',
    '            React.createElement(',
    '              "ul",',
    '              null,',
    '              projects.map((project) =>',
    '                React.createElement(',
    '                  "li",',
    '                  { key: project.target },',
    '                  React.createElement("input", {',
    '                    type: "checkbox",',
    '                    checked: selectedTargetSet.has(project.target),',
    '                    onChange: () => toggleTarget(project.target),',
    '                  }),',
    '                  React.createElement("span", null, project.displayName),',
    '                ),',
    '              ),',
    '            ),',
    '          ),',
    '          React.createElement(',
    '            "section",',
    '            { className: "card content" },',
    '            React.createElement("h2", null, "Events"),',
    '            React.createElement(',
    '              "table",',
    '              null,',
    '              React.createElement(',
    '                "thead",',
    '                null,',
    '                React.createElement(',
    '                  "tr",',
    '                  null,',
    '                  React.createElement("th", null, "Timestamp"),',
    '                  React.createElement("th", null, "Project"),',
    '                  React.createElement("th", null, "Pipeline"),',
    '                  React.createElement("th", null, "Type"),',
    '                  React.createElement("th", null, "Description"),',
    '                  React.createElement("th", null, "Link"),',
    '                ),',
    '              ),',
    '              React.createElement(',
    '                "tbody",',
    '                null,',
    '                events.map((event) => renderEventRow(event)),',
    '              ),',
    '            ),',
    '          ),',
    '        );',
    '      }',
    '',
    '      createRoot(document.getElementById("root")).render(React.createElement(App));',
  ].join('\n');
}

function WebShell({ port, script }: { port: number; script: string }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>cci</title>
        <style>{`
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; }
      body { margin: 0; min-height: 100vh; background: linear-gradient(180deg, #0f172a 0%, #111827 100%); }
      .layout { display: grid; grid-template-columns: 320px 1fr; gap: 24px; padding: 24px; }
      .card { border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 16px; background: rgba(15, 23, 42, 0.76); backdrop-filter: blur(10px); box-shadow: 0 20px 45px rgba(0, 0, 0, 0.25); }
      .sidebar, .content { padding: 20px; }
      h1, h2 { margin-top: 0; }
      input, button { width: 100%; border-radius: 10px; border: 1px solid rgba(148, 163, 184, 0.3); background: rgba(15, 23, 42, 0.7); color: inherit; padding: 10px 12px; box-sizing: border-box; }
      button { background: #2563eb; border: 0; cursor: pointer; margin-top: 12px; }
      ul { list-style: none; padding: 0; margin: 16px 0 0; max-height: 70vh; overflow: auto; }
      li { padding: 8px 0; display: flex; gap: 8px; align-items: center; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid rgba(148, 163, 184, 0.18); vertical-align: top; }
      .hint { color: #94a3b8; font-size: 14px; }
      a { color: #93c5fd; }
      @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
    `}</style>
        <script src="https://unpkg.com/react@18/umd/react.development.js" crossOrigin="anonymous" />
        <script
          src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"
          crossOrigin="anonymous"
        />
        <script src="https://unpkg.com/@babel/standalone/babel.min.js" crossOrigin="anonymous" />
      </head>
      <body>
        <div id="root" />
        <script type="text/babel" data-presets="react">
          {script}
        </script>
      </body>
    </html>
  );
}

export function renderWebApp(port: number): string {
  return `<!doctype html>${renderToStaticMarkup(<WebShell port={port} script={buildClientScript(port)} />)}`;
}
