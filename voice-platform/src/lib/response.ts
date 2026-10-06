export function successResponse(data: unknown, message = 'OK') {
  return Response.json({ success: true, data, message, code: 'SUCCESS' });
}

export function errorResponse(message: string, code = 'ERROR', status = 400) {
  return Response.json({ success: false, data: null, message, code }, { status });
}
