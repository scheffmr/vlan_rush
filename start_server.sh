#!/bin/bash
nohup node server.js > server.log 2>&1 &
sleep 2

cat <<EOF > start.html
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>VLAN-Rush Server</title>
</head>
<body style="font-family: sans-serif;">
<h2>VLAN-Rush – Wähle die IP-Adresse</h2>
<ul>
EOF

IPS=$(hostname -I)
for IP in $IPS; do
  echo "<li><a href=\"http://$IP:3000\" target=\"_blank\">http://$IP:3000</a></li>" >> start.html
  echo "<li><a href=\"https://$IP:3443\" target=\"_blank\">https://$IP:3443</a></li>" >> start.html
done

cat <<EOF >> start.html
</ul>
</body>
</html>
EOF

if which xdg-open > /dev/null; then
  xdg-open start.html
elif which open > /dev/null; then
  open start.html
fi
