var result = {app: "", window: "", role: "", value: "", selected: ""};

try {
  var se = Application("System Events");
  var procs = se.processes.whose({frontmost: true});
  if (procs.length > 0) {
    var p = procs[0];
    result.app = p.name();
    try { result.window = p.windows[0].title(); } catch(e) {}
    try {
      var fe = p.focusedUIElement;
      result.role = fe.role();
      try { result.value = (fe.value() || "").toString().substring(0, 500); } catch(e) {}
      try { result.selected = (fe.selectedText() || "").toString().substring(0, 500); } catch(e) {}
    } catch(e) {}
  }
} catch(e) {}

JSON.stringify(result);
