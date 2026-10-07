#!/bin/sh
# Builds the BepInEx plugin with the local .NET SDK and prints each distinct compiler error once.
cd "$(dirname "$0")/.." || exit 1
DOTNET="${DOTNET:-/c/Users/13079/Desktop/Cortico/tools/dotnet/dotnet}"
"$DOTNET" build plugin -c Release -o dist/plugin 2>&1 | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const errs=[...new Set(s.split(/\r?\n/).filter(l=>/error /.test(l)).map(l=>l.replace(/^.*[\\/]plugin[\\/]/,'').replace(/ \[[A-Z]:.*$/,'')))];
  console.log(errs.length?errs.join('\n'):(/Build succeeded/.test(s)?'Build succeeded':s.slice(-2000)));
  process.exitCode=errs.length?1:0;
});"
