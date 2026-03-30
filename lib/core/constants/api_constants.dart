class ApiConstants {
  ApiConstants._();

  // For Android emulator use 10.0.2.2 instead of localhost
  // For web/desktop use localhost
  static const String baseUrl = 'http://localhost:3000/api/v1';

  // Auth endpoints
  static const String login = '/auth/login';
  static const String refresh = '/auth/refresh';
  static const String me = '/auth/me';

  // Students
  static const String students = '/students';

  // Attendance
  static const String attendance = '/attendance';

  // Points
  static const String points = '/points';
}