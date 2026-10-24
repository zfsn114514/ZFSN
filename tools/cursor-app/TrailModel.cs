namespace ZfsnCursor;

// These constants and distributions mirror assets/js/app.js at 60Hz.
public sealed class Particle
{
    public double X, Y, Vx, Vy, Radius, Life = 1;
}

public sealed class TrailModel
{
    public const int MaximumParticles = 26;
    readonly Random random;
    double? lastX, lastY;
    public List<Particle> Particles { get; } = new();
    public TrailModel(int? seed = null) => random = seed.HasValue ? new Random(seed.Value) : new Random();
    public void Clear() { Particles.Clear(); lastX = lastY = null; }
    public void Move(double x, double y, double scale = 1)
    {
        if (lastX is null || lastY is null) { lastX = x; lastY = y; return; }
        double dx = x - lastX.Value, dy = y - lastY.Value;
        int steps = Math.Min((int)Math.Ceiling(Math.Sqrt(dx * dx + dy * dy) / (7 * scale)), 4);
        for (int index = 0; index < steps; index++)
        {
            double factor = steps > 1 ? (index + 1d) / steps : 1;
            Particles.Add(new Particle {
                X = lastX.Value + dx * factor, Y = lastY.Value + dy * factor,
                Vx = dx * .055 + (random.NextDouble() - .5) * .9 * scale,
                Vy = dy * .055 + (random.NextDouble() - .5) * .9 * scale,
                Radius = (2.6 + random.NextDouble() * 1.9) * scale
            });
        }
        if (Particles.Count > MaximumParticles) Particles.RemoveRange(0, Particles.Count - MaximumParticles);
        lastX = x; lastY = y;
    }
    public void Step(double seconds)
    {
        double frame = Math.Clamp(seconds, 0, .1) * 60;
        for (int index = Particles.Count - 1; index >= 0; index--)
        {
            var p = Particles[index];
            p.Life -= .028 * frame;
            if (p.Life <= 0) { Particles.RemoveAt(index); continue; }
            p.X += p.Vx * frame; p.Y += p.Vy * frame;
            p.Vx *= Math.Pow(.95, frame); p.Vy *= Math.Pow(.95, frame);
        }
    }
}
