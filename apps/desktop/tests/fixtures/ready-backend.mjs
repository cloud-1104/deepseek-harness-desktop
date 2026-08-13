// Stands in for `dsh web`: prints unrelated output, then the ready line, then stays up.
process.stdout.write('cordis: loader ready\n')
process.stdout.write('dsh web: http://127.0.0.1:45999 (LAN: http://192.168.1.4:45999)\n')
setInterval(() => {}, 60_000)
