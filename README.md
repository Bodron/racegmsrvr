# RaceGM Server

Node.js server cu autentificare email și parolă pentru aplicația Flutter RaceGM.

## Caracteristici

- ✅ Autentificare cu email și parolă
- ✅ Registrare utilizatori
- ✅ Login utilizatori
- ✅ JWT tokens pentru securitate
- ✅ Protecție parole cu bcrypt
- ✅ Rute protejate cu middleware
- ✅ Validare date cu express-validator
- ✅ MongoDB pentru stocare date

## Instalare

1. Instalează dependențele:
```bash
npm install
```

2. Creează fișierul `.env` din `.env.example`:
```bash
cp .env.example .env
```

3. Configurează variabilele de mediu în `.env`:
   - `PORT` - Portul serverului (default: 3000)
   - `MONGODB_URI` - Conectare MongoDB
   - `JWT_SECRET` - Secret pentru JWT tokens (schimbă-l în producție!)

## Rulare

### Development (cu nodemon pentru auto-reload):
```bash
npm run dev
```

### Production:
```bash
npm start
```

## Endpoints API

### Autentificare

#### POST `/api/auth/register`
Înregistrare utilizator nou.

**Body:**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "Nume Utilizator" // opțional
}
```

**Response:**
```json
{
  "message": "User registered successfully",
  "token": "jwt-token-here",
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "name": "Nume Utilizator"
  }
}
```

#### POST `/api/auth/login`
Login utilizator existent.

**Body:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "message": "Login successful",
  "token": "jwt-token-here",
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "name": "Nume Utilizator"
  }
}
```

#### GET `/api/auth/me`
Obține informații despre utilizatorul autentificat (necesită token).

**Headers:**
```
Authorization: Bearer <token>
```

**Response:**
```json
{
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "name": "Nume Utilizator"
  }
}
```

#### PUT `/api/auth/profile`
Actualizează profilul utilizatorului (necesită token).

**Headers:**
```
Authorization: Bearer <token>
```

**Body:**
```json
{
  "name": "Nume Nou", // opțional
  "email": "newemail@example.com" // opțional
}
```

#### PUT `/api/auth/change-password`
Schimbă parola utilizatorului (necesită token).

**Headers:**
```
Authorization: Bearer <token>
```

**Body:**
```json
{
  "currentPassword": "oldpassword",
  "newPassword": "newpassword123"
}
```

### Altele

#### GET `/api/health`
Verifică statusul serverului.

**Response:**
```json
{
  "status": "OK",
  "message": "Server is running"
}
```

## Utilizare în Flutter

Pentru a folosi acest server în aplicația Flutter, adaugă token-ul JWT în header-ul request-urilor:

```dart
final response = await http.get(
  Uri.parse('http://localhost:3000/api/auth/me'),
  headers: {
    'Authorization': 'Bearer $token',
    'Content-Type': 'application/json',
  },
);
```

## Securitate

- Parolele sunt hash-uite cu bcrypt înainte de salvare
- JWT tokens expiră după 7 zile
- Validare email și parolă pe server
- Middleware de autentificare pentru rute protejate
- CORS configurat pentru comunicare cu Flutter app

## Notă

Asigură-te că schimbi `JWT_SECRET` cu o valoare sigură și aleatorie în producție!
