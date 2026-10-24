using ZfsnCursor;
static void Check(bool value, string name) { if (!value) throw new Exception(name); Console.WriteLine("PASS " + name); }
var trail = new TrailModel(7); trail.Move(-100, -100); Check(trail.Particles.Count == 0, "first position does not create a burst");
trail.Move(-99, -100); Check(trail.Particles.Count == 1, "short movement creates one particle on negative-coordinate monitor");
trail.Clear(); trail.Move(0, 0); trail.Move(100, 100); Check(trail.Particles.Count == 4, "fast movement capped at four samples");
Check(trail.Particles.All(p => p.Radius >= 2.6 && p.Radius < 4.5), "same radius distribution as website");
for (int i = 1; i < 50; i++) trail.Move(i * 100, i * 50); Check(trail.Particles.Count == 26, "maximum 26 particles");
for (int i = 0; i < 40; i++) trail.Step(1d / 60); Check(trail.Particles.Count == 0, "all particles expire after mouse stops");
var scaled = new TrailModel(7); scaled.Move(0, 0, 2); scaled.Move(100, 100, 2); Check(scaled.Particles.All(p => p.Radius >= 5.2 && p.Radius < 9), "high-DPI radii scale with monitor");
var slow = new TrailModel(1); var fast = new TrailModel(1); slow.Move(0, 0); slow.Move(10, 10); fast.Move(0, 0); fast.Move(10, 10);
for (int i = 0; i < 15; i++) slow.Step(1d / 30); for (int i = 0; i < 30; i++) fast.Step(1d / 60);
Check(Math.Abs(slow.Particles[0].Life - fast.Particles[0].Life) < 1e-10, "fade lifetime independent of frame rate");
