; Extra NSIS steps for the Scape Local installer (electron-builder `nsis.include`).

!macro customInstall
  ; PC Boost needs Equalizer APO. Offer the bundled, checksum-verified 1.4.2 installer if it's missing.
  IfFileExists "$PROGRAMFILES64\EqualizerAPO\EqualizerAPO.dll" apo_done
    MessageBox MB_YESNO|MB_ICONQUESTION "Scape Local's PC Boost needs Equalizer APO (free, GPL).$\r$\n$\r$\nInstall the bundled Equalizer APO 1.4.2 now?$\r$\n$\r$\nIn its Configurator tick ONLY 'Headset Earphone (Fractal Scape Dongle)', then restart Windows.$\r$\n(You can skip this; EQ, lighting and mic settings work without it.)" IDNO apo_done
    ExecShellWait "open" "$INSTDIR\resources\EqualizerAPO-x64-1.4.2.exe"
  apo_done:
!macroend

!macro customUnInstall
  ; Skip cleanup when this uninstaller runs as part of an update (new version installing over it).
  ${ifNot} ${isUpdated}
    !insertmacro scapeCleanup
  ${endIf}
!macroend

!macro scapeCleanup
  ; Remove the "Start with Windows" entry (app.setLoginItemSettings, name = AppUserModelId).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "local.scape"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "local.scape"
  ; If PC Boost was left on, neutralise it: keep the file (config.txt still includes it) but drop the preamp.
  IfFileExists "$PROGRAMFILES64\EqualizerAPO\config\scape-local-boost.txt" 0 boost_done
    FileOpen $0 "$PROGRAMFILES64\EqualizerAPO\config\scape-local-boost.txt" w
    FileWrite $0 "# Scape Local was uninstalled; Boost disabled. The Include block in config.txt can be removed.$\r$\n"
    FileClose $0
  boost_done:
!macroend
